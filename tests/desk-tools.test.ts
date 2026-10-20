// Read-only desk tools (search, fetch, ls, read) and the model-round loop in direct-model mode.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { DirectModel, DirectThreadStore } from '../src/server/direct-model/index.js';
import { parseToolCalls, runTool, stripToolCalls } from '../src/server/direct-model/tools.js';

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
  await symlink(outside, path.join(dir, 'escape'));
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
    const found = await runTool({ name: 'search', arg: 'example' }, { fetch: fakeFetch });
    expect(found).toContain('https://example.com/a');
    expect(found).toContain('Snippet A');
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
});
