// In-app chat in direct-model mode (WO-08): send, streamed reply, history on
// reopen, and Intelligence-only controls hidden. Runs the client session against
// the real WO-07 routes (createApp + DirectModel) with a stub model server.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  DirectModel,
  DirectThreadStore,
} from '../src/server/direct-model/index.js';
import type { Config } from '../src/server/research.js';
import type { Conversation, Dot } from '../src/shared/types';

vi.hoisted(() => {
  const memory = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage ??= {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  };
});
// The Intelligence thread service must not be touched in direct mode.
vi.mock('@copilotkit/react-core/v2', () => ({
  useThreads: () => {
    throw new Error('Intelligence thread service used in direct mode');
  },
}));
type ClientModule = typeof import('../src/client/direct-chat');
let client: ClientModule;
let DirectChat: typeof import('../src/client/DirectChat').DirectChat;
let LocalThreadList: typeof import('../src/client/ThreadList').LocalThreadList;
beforeAll(async () => {
  client = await import('../src/client/direct-chat');
  DirectChat = (await import('../src/client/DirectChat')).DirectChat;
  LocalThreadList = (await import('../src/client/ThreadList')).LocalThreadList;
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Stub OpenAI-compatible server that streams a reply in pieces. */
async function modelStub(pieces = ['Hel', 'lo ', 'there']) {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: pieces.join('') } }],
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of pieces)
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
      );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function backend(pieces?: string[]) {
  const url = await modelStub(pieces);
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const threads = new DirectThreadStore(':memory:');
  const direct = new DirectModel({
    store,
    workspace,
    threads,
    model: { apiKey: 'stub', baseUrl: url, model: 'cadis-free' },
    backoffMs: 0,
    log: () => undefined,
  });
  const config: Config = { mode: 'live', baseUrl: url, apiKey: 'stub' };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    direct,
  });
  cleanups.push(() => {
    store.close();
    workspace.close();
    threads.close();
  });
  // The browser's fetch('/api/...') served by the real app.
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(String(input), init)) as typeof fetch;
  const dot = workspace.dots()[0];
  const thread = direct.createConversation(dot.id, 'Desk thread');
  return { app, fetchImpl, workspace, dot, thread };
}

describe('direct-model chat client', () => {
  it('detects direct mode and labels the Dot model', () => {
    expect(client.isDirectMode({ mode: 'direct-model' })).toBe(true);
    expect(client.isDirectMode({})).toBe(false);
    expect(client.isDirectMode(undefined)).toBe(false);
    const workspace = { model: { model: 'cadis-free', fallbackModel: null } };
    expect(client.dotModelLabel({ model: 'cadis' }, workspace)).toBe('cadis');
    expect(client.dotModelLabel({ model: null }, workspace)).toBe('cadis-free');
  });

  it('sends a message and shows the reply as it streams, then saves it', async () => {
    const { fetchImpl, thread } = await backend();
    const session = new client.DirectChatSession(thread.id, fetchImpl);
    await session.load();
    expect(session.get()).toMatchObject({ loaded: true, messages: [] });
    const seen: string[] = [];
    session.subscribe(() => {
      const last = session.get().messages.at(-1);
      if (last?.role === 'assistant') seen.push(String(last.content));
    });
    expect(await session.send('Say hello')).toBe(true);
    expect(seen.slice(0, 3)).toEqual(['Hel', 'Hello ', 'Hello there']);
    const final = session.get();
    expect(final.running).toBe(false);
    expect(final.model).toBe('cadis-free');
    expect(final.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there'],
    ]);
    expect(final.messages[1].id.startsWith('pending-')).toBe(false);
  });

  it('loads saved history when a conversation is reopened', async () => {
    const { fetchImpl, thread } = await backend(['First answer']);
    const first = new client.DirectChatSession(thread.id, fetchImpl);
    await first.load();
    await first.send('First question');
    const reopened = new client.DirectChatSession(thread.id, fetchImpl);
    await reopened.load();
    expect(reopened.get().messages.map((m) => m.content)).toEqual([
      'First question',
      'First answer',
    ]);
  });

  it('shows the server error and restores the conversation when a turn fails', async () => {
    const { fetchImpl, thread } = await backend([]);
    const session = new client.DirectChatSession(thread.id, fetchImpl);
    await session.load();
    expect(await session.send('hi')).toBe(false);
    expect(session.get().messages).toEqual([]);
    expect(session.get().error).toBe(
      'The model returned an empty reply. Please try again in a moment.',
    );
    const missing = new client.DirectChatSession('nope', fetchImpl);
    await missing.load();
    expect(missing.get()).toMatchObject({
      loaded: false,
      error: 'Conversation not found.',
    });
  });

  it('parses split SSE chunks and reports a stream error event', async () => {
    const encoder = new TextEncoder();
    const respond = (chunks: string[]) =>
      (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks)
                controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )) as unknown as typeof fetch;
    const pieces: string[] = [];
    const done = await client.streamReply('t', 'x', {
      onDelta: (text) => pieces.push(text),
      fetchImpl: respond([
        'event: delta\ndata: {"te',
        'xt":"A"}\n\nevent: delta\ndata: {"text":"B"}\n\n',
        'event: done\ndata: {"message":{"id":"m","threadId":"t","role":"assistant","content":"AB","model":"cadis","createdAt":1},"model":"cadis"}\n\n',
      ]),
    });
    expect(pieces).toEqual(['A', 'B']);
    expect(done.model).toBe('cadis');
    await expect(
      client.streamReply('t', 'x', {
        onDelta: () => undefined,
        fetchImpl: respond([
          'event: error\ndata: {"error":"The model is temporarily unavailable. Please try again in a moment."}\n\n',
        ]),
      }),
    ).rejects.toThrow('temporarily unavailable');
    await expect(
      client.streamReply('t', 'x', {
        onDelta: () => undefined,
        fetchImpl: respond(['event: delta\ndata: {"text":"A"}\n\n']),
      }),
    ).rejects.toThrow('interrupted');
  });
});

describe('direct-model chat panel', () => {
  const dot: Dot = {
    id: 'dot-1',
    spaceId: 's',
    spaceIds: ['s'],
    name: 'devvy.',
    instructions: 'Development seat.',
    researchAllowed: true,
    memoryAllowed: true,
    createdAt: 1,
    model: 'cadis',
  };
  const thread: Conversation = {
    id: 'thread-1',
    dotId: 'dot-1',
    ownerId: 'owner',
    title: 'Desk thread',
    createdAt: 1,
  };

  it('renders history with the existing transcript, shows the model and hides Intelligence-only controls', async () => {
    const fetchImpl = (async () =>
      Response.json({
        messages: [
          {
            id: 'u',
            threadId: 'thread-1',
            role: 'user',
            content: 'Status?',
            model: null,
            createdAt: 1,
          },
          {
            id: 'a',
            threadId: 'thread-1',
            role: 'assistant',
            content: 'All **green**.',
            model: 'cadis',
            createdAt: 2,
          },
        ],
      })) as unknown as typeof fetch;
    const session = new client.DirectChatSession(thread.id, fetchImpl);
    await session.load();
    const html = renderToStaticMarkup(
      <DirectChat
        thread={thread}
        dot={dot}
        model="cadis"
        onConsumed={() => undefined}
        paused={false}
        onSaved={() => undefined}
        onSchedule={() => undefined}
        session={session}
      />,
    );
    expect(html).toContain('chat-bubble user');
    expect(html).toContain('<strong>green</strong>');
    expect(html).toContain('cadis');
    expect(html).toContain('Schedule a task in this conversation');
    expect(html).toContain(client.DIRECT_MODE_NOTE.replace(/'/g, '&#x27;'));
    for (const hidden of [
      'Start voice call',
      'Save conversation as page',
      'Attach files or images',
      'Add source page link',
      'Show computer',
    ])
      expect(html).not.toContain(hidden);
  });

  it('lists local conversations without the Intelligence thread service', () => {
    const html = renderToStaticMarkup(
      <LocalThreadList
        dotId={dot.id}
        dots={[dot]}
        local={[thread]}
        onSelect={() => undefined}
        onNew={() => undefined}
      />,
    );
    expect(html).toContain('Desk thread');
    expect(html).not.toContain('Conversation sync unavailable');
  });
});
