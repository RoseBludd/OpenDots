// Direct-model mode (WO-07): Dots and tasks on the OpenAI-compatible model when
// INTELLIGENCE_API_KEY is unset. A local stub server stands in for the endpoint.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  DirectModel,
  DirectThreadStore,
  directModeEnabled,
  directModelConfig,
} from '../src/server/direct-model/index.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { Config } from '../src/server/research.js';

const KEY = 'stub-key-not-a-secret';
interface Answer {
  status?: number;
  json?: unknown;
  sse?: string[];
  hang?: boolean;
}
type Reply = (
  body: {
    model: string;
    messages: { role: string; content: string }[];
    stream?: boolean;
  },
  call: number,
) => Answer | undefined;

interface Stub {
  url: string;
  calls: {
    model: string;
    messages: { role: string; content: string }[];
    auth?: string;
  }[];
  close: () => Promise<void>;
}
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ok = (content: string): Answer => ({
  json: { choices: [{ message: { role: 'assistant', content } }] },
});

async function stub(reply: Reply): Promise<Stub> {
  const calls: Stub['calls'] = [];
  const hanging: IncomingMessage[] = [];
  const server: Server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({
      model: body.model,
      messages: body.messages,
      auth: request.headers.authorization,
    });
    const answer = reply(body, calls.length) ?? ok('fallback stub reply');
    if (answer.hang) {
      hanging.push(request);
      return;
    }
    if (answer.sse) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of answer.sse) response.write(`data: ${event}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(answer.status ?? 200, {
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(answer.json ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  cleanups.push(close);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close,
  };
}

function fixture(
  endpoint: Stub,
  options: { fallbackModel?: string; budgetMs?: number } = {},
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const threads = new DirectThreadStore(':memory:');
  const logs: string[] = [];
  const direct = new DirectModel({
    store,
    workspace,
    threads,
    model: {
      apiKey: KEY,
      baseUrl: endpoint.url,
      model: 'cadis-free',
      fallbackModel: options.fallbackModel,
    },
    backoffMs: 0,
    budgetMs: options.budgetMs ?? 10_000,
    log: (line) => logs.push(line),
  });
  const config: Config = { mode: 'live', baseUrl: endpoint.url, apiKey: KEY };
  const runner = new Runner(
    store,
    config,
    (claim, memories, signal, progress) =>
      direct.execute(claim, memories, signal, progress),
  );
  const app = createApp({ store, runner, config, direct });
  cleanups.push(() => {
    runner.stop();
    store.close();
    workspace.close();
    threads.close();
  });
  return { store, workspace, threads, direct, runner, app, logs };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function conversation(app: ReturnType<typeof createApp>, dotId: string) {
  const response = await app.request(
    '/api/conversations',
    post({ dotId, title: 'Desk thread' }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; dotId: string };
}

let peerId = '';

describe('direct-model mode', () => {
  it('is enabled only without an Intelligence key and with a model key', () => {
    expect(directModeEnabled({ apiKey: 'k' })).toBe(true);
    expect(directModeEnabled({ apiKey: 'k', intelligenceKey: 'i' })).toBe(
      false,
    );
    expect(directModeEnabled({})).toBe(false);
    const config = directModelConfig(
      {
        apiKey: 'k',
        baseUrl: 'https://x/v1',
        model: 'cadis-free',
      } as PlatformConfig,
      { OPENAI_FALLBACK_MODEL: 'cadis' },
    );
    expect(config.fallbackModel).toBe('cadis');
    expect(
      directModelConfig(
        { apiKey: 'k', baseUrl: 'https://x/v1' } as PlatformConfig,
        {},
      ),
    ).toMatchObject({ model: 'cadis-free', fallbackModel: undefined });
  });

  it('answers a Dot chat with a real model reply and reports direct-model state', async () => {
    const endpoint = await stub(() => ok('Hello from the stub model.'));
    const { app, workspace } = fixture(endpoint);
    const dot = workspace.dots()[0];
    const thread = await conversation(app, dot.id);
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'Say hello.' }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      message: { content: string; role: string };
      model: string;
    };
    expect(body.message).toMatchObject({
      role: 'assistant',
      content: 'Hello from the stub model.',
    });
    expect(body.model).toBe('cadis-free');
    expect(endpoint.calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(endpoint.calls[0].messages[0].role).toBe('system');
    expect(endpoint.calls[0].messages[0].content).toContain(dot.name);
    expect(endpoint.calls[0].messages.at(-1)).toEqual({
      role: 'user',
      content: 'Say hello.',
    });
    const state = (await (await app.request('/api/state')).json()) as {
      mode: string;
    };
    expect(state.mode).toBe('direct-model');
    const ws = (await (await app.request('/api/workspace')).json()) as {
      mode: string;
      conversations: { id: string }[];
    };
    expect(ws.mode).toBe('direct-model');
    expect(ws.conversations.map((c) => c.id)).toContain(thread.id);
  });

  it('keeps thread history locally and sends it on the next turn', async () => {
    const endpoint = await stub((_body, call) => ok(`reply ${call}`));
    const { app, workspace } = fixture(endpoint);
    const thread = await conversation(app, workspace.dots()[0].id);
    await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'first question' }),
    );
    await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'second question' }),
    );
    expect(endpoint.calls[1].messages.slice(1)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second question' },
    ]);
    const history = (await (
      await app.request(`/api/conversations/${thread.id}/messages`)
    ).json()) as { messages: { role: string; content: string }[] };
    expect(history.messages.map((m) => m.content)).toEqual([
      'first question',
      'reply 1',
      'second question',
      'reply 2',
    ]);
    expect(
      (await app.request('/api/conversations/not-a-thread/messages')).status,
    ).toBe(404);
  });

  it('streams a reply as server-sent events when asked', async () => {
    const endpoint = await stub(() => ({
      sse: [
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
      ],
    }));
    const { app, workspace, threads } = fixture(endpoint);
    const thread = await conversation(app, workspace.dots()[0].id);
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'stream please', stream: true }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('event: done');
    expect(threads.messages(thread.id).at(-1)?.content).toBe('Hello');
  });

  it('runs a task bound to a thread and an unbound task to completion', async () => {
    const endpoint = await stub((body) =>
      ok(`task result for: ${body.messages.at(-1)?.content}`),
    );
    const { app, workspace, store, runner, threads } = fixture(endpoint);
    const thread = await conversation(app, workspace.dots()[0].id);
    const created = await app.request(
      '/api/tasks',
      post({ prompt: 'Summarize my week', threadId: thread.id }),
    );
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    expect(
      (
        await app.request(
          `/api/tasks/${task.id}/actions`,
          post({ action: 'run' }),
        )
      ).status,
    ).toBe(200);
    await runner.tick();
    const detail = store.detail(task.id)!;
    expect(detail.task.status).toBe('completed');
    expect(detail.runs[0].result?.text).toBe(
      'task result for: Summarize my week',
    );
    expect(threads.messages(thread.id).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
    store.createTask('Plan a quiet weekend');
    await runner.tick();
    const unbound = store
      .tasks()
      .find((t) => t.prompt === 'Plan a quiet weekend')!;
    expect(store.detail(unbound.id)!.task.status).toBe('completed');
    expect(store.detail(unbound.id)!.runs[0].result?.text).toContain(
      'Plan a quiet weekend',
    );
    expect(
      (
        await app.request(
          '/api/tasks',
          post({ prompt: 'Not my thread', threadId: 'foreign' }),
        )
      ).status,
    ).toBe(403);
  });

  it('retries a 502 and succeeds', async () => {
    const endpoint = await stub((_body, call) =>
      call === 1
        ? { status: 502, json: { error: 'bad gateway' } }
        : ok('recovered'),
    );
    const { app, workspace } = fixture(endpoint);
    const thread = await conversation(app, workspace.dots()[0].id);
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'hi' }),
    );
    expect(response.status).toBe(201);
    expect(
      ((await response.json()) as { message: { content: string } }).message
        .content,
    ).toBe('recovered');
    expect(endpoint.calls).toHaveLength(2);
  });

  it('falls back once to OPENAI_FALLBACK_MODEL when the primary keeps failing', async () => {
    const endpoint = await stub((body) =>
      body.model === 'cadis-free'
        ? { status: 503, json: { error: 'unavailable' } }
        : ok(`served by ${body.model}`),
    );
    const { app, workspace, logs } = fixture(endpoint, {
      fallbackModel: 'cadis',
    });
    const thread = await conversation(app, workspace.dots()[0].id);
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'hi' }),
    );
    const body = (await response.json()) as {
      model: string;
      message: { content: string };
    };
    expect(body.model).toBe('cadis');
    expect(body.message.content).toBe('served by cadis');
    expect(endpoint.calls.at(-1)?.model).toBe('cadis');
    expect(logs.some((line) => line.includes('model=cadis '))).toBe(true);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('does not fall back to another model unless configured', async () => {
    const endpoint = await stub(() => ({
      status: 503,
      json: { error: 'unavailable' },
    }));
    const { app, workspace, threads } = fixture(endpoint);
    const thread = await conversation(app, workspace.dots()[0].id);
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'hi' }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error:
        'The model is temporarily unavailable. Please try again in a moment.',
    });
    expect(new Set(endpoint.calls.map((c) => c.model))).toEqual(
      new Set(['cadis-free']),
    );
    expect(threads.messages(thread.id)).toHaveLength(0);
  });

  it('retries an empty reply once, then returns a clean error', async () => {
    const once = await stub((_body, call) =>
      call === 1 ? ok('') : ok('second try'),
    );
    const first = fixture(once);
    const thread = await conversation(first.app, first.workspace.dots()[0].id);
    const recovered = await first.app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'hi' }),
    );
    expect(
      ((await recovered.json()) as { message: { content: string } }).message
        .content,
    ).toBe('second try');

    const always = await stub(() => ok('   '));
    const second = fixture(always);
    const other = await conversation(second.app, second.workspace.dots()[0].id);
    const failed = await second.app.request(
      `/api/conversations/${other.id}/messages`,
      post({ content: 'hi' }),
    );
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: 'The model returned an empty reply. Please try again in a moment.',
    });
    expect(always.calls).toHaveLength(2);
  });

  it('stops a turn that exceeds the run budget with a clean error', async () => {
    const endpoint = await stub(() => ({ hang: true }));
    const { app, workspace, store, runner } = fixture(endpoint, {
      budgetMs: 300,
    });
    const thread = await conversation(app, workspace.dots()[0].id);
    const started = Date.now();
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'hi' }),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /^The run took longer than/,
    );
    store.createTask('A slow task');
    await runner.tick();
    // WO-TWIN-C: budget overruns are retryable run failures in the ported
    // work-order flow — the task re-queues with the clean error retained.
    expect(store.tasks()[0].status).toBe('queued');
    expect(store.tasks()[0].error).toMatch(/took longer than/);
  });

  it('answers 501 on Intelligence-only routes instead of 404', async () => {
    const endpoint = await stub(() => ok('unused'));
    const { app, workspace } = fixture(endpoint);
    const dotId = workspace.dots()[0].id;
    for (const [path, init] of [
      ['/api/copilotkit/agent/run', post({})],
      ['/api/voice/calls', post({ threadId: 'x', sdp: 'y' })],
      [`/api/dots/${dotId}/computer`, undefined],
      [`/api/dots/${dotId}/computer/start`, post({})],
      ['/api/spaces/s/pages', undefined],
    ] as const) {
      const response = await app.request(path, init);
      expect(response.status, path).toBe(501);
      expect(((await response.json()) as { error: string }).error).toContain(
        'requires Intelligence',
      );
    }
  });

  it('leaves the app unchanged when direct mode is off', async () => {
    const store = new Store(':memory:');
    const config: Config = {
      mode: 'sample',
      baseUrl: 'https://api.openai.com/v1',
    };
    const runner = new Runner(store, config);
    const app = createApp({ store, runner, config });
    cleanups.push(() => store.close());
    expect((await app.request('/api/workspace')).status).toBe(404);
    expect(
      ((await (await app.request('/api/state')).json()) as { mode: string })
        .mode,
    ).toBe('sample');
  });
  it('hands work to another desk, runs it there and relays the reply back', async () => {
    const endpoint = await stub((body, call) => {
      const last = body.messages.at(-1)!.content;
      if (last.startsWith('Handoff from'))
        return ok('Peer answer: the build is green.');
      return ok(`Sure.\n[[handoff:${peerId}]] Check whether the build is green.`);
    });
    const { app, workspace, threads, direct, store } = fixture(endpoint);
    const from = workspace.dots()[0];
    const to = workspace.createDot(workspace.spaces()[0].id, "Peer", "Checks builds.", false, false);
    peerId = to.id;
    const thread = await conversation(app, from.id);
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      post({ content: 'Ask the other desk about the build.' }),
    );
    const body = (await response.json()) as { message: { content: string } };
    expect(body.message.content).toContain(`Handed to ${to.name}`);
    expect(body.message.content).not.toContain('[[handoff');
    const task = store.tasks().find((t) => t.prompt.startsWith('Handoff from'))!;
    expect(task).toBeTruthy();
    await direct.execute(
      { id: task.id, prompt: task.prompt } as never,
      [],
      new AbortController().signal,
      () => undefined,
    );
    const relayed = threads.messages(thread.id).at(-1)!;
    expect(relayed.content).toContain('Peer answer: the build is green.');
    expect(relayed.content).toContain(`Reply from ${to.name}`);
  });
});
