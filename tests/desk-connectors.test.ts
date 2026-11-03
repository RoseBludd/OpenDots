// GitHub/Cloudflare GET-only connectors and draft-only email/Slack.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseToolCalls, runTool, stripToolCalls } from '../src/server/direct-model/tools.js';

const BR = String.fromCharCode(92) + 'n'; // a literal backslash-n typed by the model
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function fakeFetch(calls: { url: string; init: RequestInit }[], status = 200) {
  return (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ sha: 'abc' }]), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('connector tags', () => {
  it('parses github, cloudflare and draft tags and strips them', () => {
    const text = '[[github: /repos/a/b/commits?per_page=3]]\n[[cloudflare: /zones?per_page=5]]\n[[draft_email: a@b.co | Hi | Line1' + BR + 'Line2 | x]]\n[[draft_slack: #ops | hello]]';
    expect(parseToolCalls(text)).toEqual([
      { name: 'github', arg: '/repos/a/b/commits?per_page=3' },
      { name: 'cloudflare', arg: '/zones?per_page=5' },
      { name: 'draft_email', arg: 'a@b.co | Hi | Line1' + BR + 'Line2 | x' },
      { name: 'draft_slack', arg: '#ops | hello' },
    ]);
    expect(stripToolCalls(text)).toBe('');
  });
});

describe('github / cloudflare', () => {
  it('issues GET-only requests with the token and never follows redirects', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const out = await runTool({ name: 'github', arg: '/repos/RoseBludd/OpenDots/commits?per_page=3' }, { githubToken: 'tok', fetch: fakeFetch(calls) });
    expect(out).toContain('abc');
    expect(calls[0].url).toBe('https://api.github.com/repos/RoseBludd/OpenDots/commits?per_page=3');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.redirect).toBe('manual');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBeUndefined();
  });
  it('substitutes {account_id} and refuses host escapes, traversal and a missing token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const opts = { cloudflareToken: 'cf', cloudflareAccountId: 'acct1', fetch: fakeFetch(calls) };
    await runTool({ name: 'cloudflare', arg: '/accounts/{account_id}/workers/scripts' }, opts);
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/workers/scripts');
    for (const bad of ['//evil.com/x', '@evil.com/x', 'https://evil.com', '/zones/../x', '/a b', '/a%2e%2e/b']) {
      expect(await runTool({ name: 'cloudflare', arg: bad }, opts), bad).toMatch(/^Tool failed/);
    }
    expect(calls).toHaveLength(1);
    expect(await runTool({ name: 'github', arg: '/user' }, { fetch: fakeFetch(calls) })).toMatch(/not enabled/);
    expect(await runTool({ name: 'github', arg: '/user' }, { githubToken: 't', fetch: fakeFetch(calls, 404) })).toMatch(/HTTP 404/);
  });
});

describe('drafts', () => {
  it('saves email and slack drafts as files and sends nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'drafts-'));
    dirs.push(root);
    const calls: unknown[] = [];
    const fetch = (async (...a: unknown[]) => { calls.push(a); return new Response('{}'); }) as unknown as typeof globalThis.fetch;
    const r1 = await runTool({ name: 'draft_email', arg: 'a@b.co | Hello | Hi there' + BR + 'Bye | ps' }, { workRoot: root, fetch });
    const r2 = await runTool({ name: 'draft_slack', arg: '#ops | deploy done' }, { workRoot: root, fetch });
    expect(r1).toMatch(/NOT SENT/);
    expect(r2).toMatch(/NOT SENT/);
    const files = await readdir(path.join(root, 'drafts'));
    expect(files).toHaveLength(2);
    const email = JSON.parse(await readFile(path.join(root, 'drafts', files.find((f) => f.includes('email'))!), 'utf8'));
    expect(email).toMatchObject({ kind: 'email', to: 'a@b.co', subject: 'Hello', body: 'Hi there' + String.fromCharCode(10) + 'Bye | ps', status: 'draft' });
    expect(calls).toHaveLength(0);
    expect(await runTool({ name: 'draft_email', arg: 'only-one' }, { workRoot: root })).toMatch(/^Tool failed/);
  });
  it('has no send code path or email key in the app', () => {
    const src = readFileSync('src/server/direct-model/tools.ts', 'utf8');
    expect(src).not.toMatch(/chat\.postMessage|hooks\.slack|smtp|sendgrid|nodemailer/i);
    expect(src).not.toMatch(/EMAILZS_KEY/);
  });
});
