// Read-only desk tools (search, fetch, ls, read) and the model-round loop in direct-model mode.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { DirectModel, DirectThreadStore } from '../src/server/direct-model/index.js';
import { fetchMaxChars, parseToolCalls, runTool, stripToolCalls } from '../src/server/direct-model/tools.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-files-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'archy'));
  await writeFile(path.join(dir, 'archy', 'BRIEF.md'), 'Archy owns diagrams.');
  await writeFile(path.join(dir, 'archy', 'bundle.tgz'), 'x');
  const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.txt'), 'nope');
  try {
    await symlink(outside, path.join(dir, 'escape'), 'junction');
  } catch {
    // Windows test envs often lack symlink privilege; the traversal guard is still exercised above.
  }
  return dir;
}

describe('desk tools', () => {
  it('parses and strips tool tags', () => {
    const text = 'Looking.\n[[search: opendots docs]]\n[[read: archy/BRIEF.md]]';
    expect(parseToolCalls(text)).toEqual([
      { name: 'search', arg: 'opendots docs' },
      { name: 'read', arg: 'archy/BRIEF.md' },
    ]);
    expect(stripToolCalls(text)).toBe('Looking.');
  });

  it('accepts drifted tag shapes from the model', () => {
    expect(parseToolCalls("<|tool_call_start|>[[search(query='node lts 2026')]<|tool_call_end|>")).toEqual([{ name: 'search', arg: 'node lts 2026' }]);
    expect(parseToolCalls('[[fetch: https://example.com]]')).toEqual([{ name: 'fetch', arg: 'https://example.com' }]);
    expect(parseToolCalls('[[read(path="archy/BRIEF.md")]]')).toEqual([{ name: 'read', arg: 'archy/BRIEF.md' }]);
    expect(stripToolCalls("Hi <|tool_call_start|>[[search(query='x')]<|tool_call_end|>")).toBe('Hi');
  });

  it('lists and reads files under the root only', async () => {
    const filesRoot = await root();
    expect(await runTool({ name: 'ls', arg: '.' }, { filesRoot })).toContain('dir  archy');
    expect(await runTool({ name: 'read', arg: 'archy/BRIEF.md' }, { filesRoot })).toBe('Archy owns diagrams.');
    expect(await runTool({ name: 'read', arg: '../../etc/passwd' }, { filesRoot })).toContain('Tool failed');
    expect(await runTool({ name: 'read', arg: 'escape/secret.txt' }, { filesRoot })).toContain('outside the desk files');
    expect(await runTool({ name: 'read', arg: 'archy/bundle.tgz' }, { filesRoot })).toContain('binary');
    expect(await runTool({ name: 'read', arg: 'x' }, {})).toContain('not enabled');
  });

  it('refuses private addresses and follows only public redirects', async () => {
    for (const url of ['http://127.0.0.1:4310/', 'http://100.86.225.40/', 'http://10.0.0.5/', 'file:///etc/passwd', 'http://[::1]/'])
      expect(await runTool({ name: 'fetch', arg: url }, { fetch: (() => { throw new Error('called'); }) as never }), url).toContain('Tool failed');
  });

  it('turns an HTML page into text and parses search results', async () => {
    const page = '<html><script>x()</script><body><h1>Title</h1><p>Hello&nbsp;world</p></body></html>';
    const ddg = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example <b>A</b></a><a class="result__snippet" href="x">Snippet A</a>';
    const fakeFetch = (async (input: string | URL | Request) =>
      String(input).includes('duckduckgo')
        ? new Response(ddg, { headers: { 'content-type': 'text/html' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const fetched = await runTool({ name: 'fetch', arg: 'https://1.1.1.1/' }, { fetch: fakeFetch });
    expect(fetched).toContain('Title');
    expect(fetched).toContain('Hello world');
    expect(fetched).not.toContain('x()');
    const found = await runTool({ name: 'search', arg: 'example' }, { fetch: fakeFetch, parallelSearch: (async () => { throw new Error('unavailable'); }) as never });
    expect(found).toContain('https://example.com/a');
    expect(found).toContain('Snippet A');
  });

  it('searches through the Parallel lane when configured, DuckDuckGo otherwise', async () => {
    const out = await runTool({ name: 'search', arg: 'node lts' }, {
      parallelSearch: (async (request: { objective: string }) => [
        { title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases', text: `LTS table for ${request.objective}` },
      ]) as never,
    });
    expect(out).toContain('https://nodejs.org/en/about/previous-releases');
    expect(out).toContain('LTS table for node lts');
    const fallback = await runTool({ name: 'search', arg: 'x' }, {
      parallelSearch: (async () => { throw new Error('quota'); }) as never,
      fetch: (async () => new Response('<a class="result__a" href="https://e.com/">E</a>', { headers: { 'content-type': 'text/html' } })) as never,
    });
    expect(fallback).toContain('https://e.com/');
  });

  it('runs a tool round and answers from the result', async () => {
    const filesRoot = await root();
    const calls: { role: string; content: string }[][] = [];
    const fake = (async (_url: unknown, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages;
      calls.push(messages);
      const content = calls.length === 1 ? '[[read: archy/BRIEF.md]]' : 'The brief says: Archy owns diagrams.';
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const threads = new DirectThreadStore(':memory:');
    cleanups.push(() => { store.close(); workspace.close(); threads.close(); });
    const direct = new DirectModel({
      store, workspace, threads, filesRoot, fetch: fake, backoffMs: 0, budgetMs: 10_000,
      model: { apiKey: 'k', baseUrl: 'http://stub/v1', model: 'm' },
    });
    const dot = workspace.dots()[0];
    const thread = direct.createConversation(dot.id, 'tools');
    const result = await direct.turn(thread.id, 'What does the archy brief say?');
    expect(result.text).toBe('The brief says: Archy owns diagrams.');
    expect(calls).toHaveLength(2);
    expect(calls[0][0].content).toContain('[[read: <path>]]');
    expect(calls[1].at(-1)!.content).toContain('Archy owns diagrams.');
    expect(threads.messages(thread.id).map((m) => m.content).join('\n')).not.toContain('[[read');
  });

  it('caps fetch and read at the fetch cap while search stays at 9000', async () => {
    const long = 'x'.repeat(90_000);
    const fakeFetch = (async () => new Response(long, { headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    expect(await runTool({ name: 'fetch', arg: 'https://1.1.1.1/' }, { fetch: fakeFetch })).toContain('[truncated at 60000 of 90000 chars]');
    const filesRoot = await root();
    await writeFile(path.join(filesRoot, 'big.md'), 'y'.repeat(90_000), 'utf8');
    expect(await runTool({ name: 'read', arg: 'big.md' }, { filesRoot })).toContain('[truncated at 60000 of 90000 chars]');
    const search = await runTool({ name: 'search', arg: 'q' }, { parallelSearch: (async () => Array.from({ length: 12 }, (_, i) => ({ title: 'T' + i, url: 'https://e.com/' + i, text: 'z'.repeat(900) }))) as never });
    expect(String(search).length).toBeLessThanOrEqual(9100);
  });

  it('clamps DESK_FETCH_MAX_CHARS with a 60000 default', () => {
    expect(fetchMaxChars({})).toBe(60_000);
    expect(fetchMaxChars({ DESK_FETCH_MAX_CHARS: '120000' })).toBe(120_000);
    expect(fetchMaxChars({ DESK_FETCH_MAX_CHARS: 'junk' })).toBe(60_000);
    expect(fetchMaxChars({ DESK_FETCH_MAX_CHARS: '500' })).toBe(60_000);
    expect(fetchMaxChars({ DESK_FETCH_MAX_CHARS: '900000' })).toBe(500_000);
  });

  it('falls back to the anonymous Parallel tier when the keyed call is rejected', async () => {
    const attempts: (string | undefined)[] = [];
    const out = await runTool({ name: 'search', arg: 'node lts' }, {
      parallelApiKey: 'test-key',
      parallelSearch: (async (_request: { objective: string }, config: { parallelApiKey?: string }) => {
        attempts.push(config?.parallelApiKey);
        if (config?.parallelApiKey) throw new Error('HTTP 401 rejected');
        return [{ title: 'Node.js Releases', url: 'https://nodejs.org/en/about/', text: 'LTS table' }];
      }) as never,
    });
    expect(attempts).toEqual(['test-key', undefined]);
    expect(out).toContain('https://nodejs.org/en/about/');
  });

  it('reports a clear rate-limit message when the Parallel tier is rate-limited and DuckDuckGo times out', async () => {
    expect(await runTool({ name: 'search', arg: 'node lts' }, {
      parallelSearch: (async () => { throw new Error('HTTP 429 too many requests'); }) as never,
      fetch: (async () => { throw new Error('ddg timeout'); }) as never,
    })).toBe('Tool failed: Parallel search is rate-limited, try again shortly.');
  });
});
