// Hybrid mode (WO-P1): Intelligence (platform) stays the primary chat/task path,
// but direct-model's own REST routes mount alongside it so every Dot also has a
// plain HTTP conversation API, without direct ever shadowing platform's routes
// or platform's task execution.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import {
  DirectModel,
  DirectThreadStore,
} from '../src/server/direct-model/index.js';
import type { Config } from '../src/server/research.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

async function stubModel(content: string) {
  const server: Server = createServer(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function fixture() {
  const stubUrl = await stubModel('hybrid-pong');
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const threads = new DirectThreadStore(':memory:');
  cleanups.push(() => {
    store.close();
    workspace.close();
    threads.close();
  });
  // No intelligenceKey: exercises platform's routes/behavior without calling the real API,
  // same pattern as tests/page-routes.test.ts.
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://example.com',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const direct = new DirectModel({
    store,
    workspace,
    threads,
    model: { apiKey: 'stub-key-not-a-secret', baseUrl: stubUrl, model: 'cadis-free' },
    backoffMs: 0,
    budgetMs: 10_000,
  });
  const config: Config = { mode: 'live', baseUrl: stubUrl };
  const runner = new Runner(store, config);
  const app = createApp({ store, runner, config, platform, direct });
  return { app, store, workspace, runner };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('hybrid mount (platform + direct)', () => {
  it("keeps platform's /api/workspace as the one that answers, not direct's", async () => {
    const { app } = await fixture();
    const response = await app.request('/api/workspace');
    expect(response.status).toBe(200);
    const body = await response.json();
    // direct-model/routes.ts's /workspace always includes "mode" and "model"; platform's does not.
    expect(body.mode).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(Array.isArray(body.dots)).toBe(true);
  });

  it("mounts direct-model's /conversations/:id/messages alongside platform so Dots get a plain REST chat API", async () => {
    const { app, workspace } = await fixture();
    const dotId = workspace.dots()[0].id;
    const thread = workspace.bindThread(randomUUID(), dotId, 'hybrid parity');
    const response = await app.request(
      `/api/conversations/${thread.id}/messages`,
      json({ content: 'ping' }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.message.content).toBe('hybrid-pong');
  });
});
