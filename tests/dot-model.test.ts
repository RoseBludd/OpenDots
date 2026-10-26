// Per-Dot model selection (WO-03): model and desk-key resolution per Dot, with a
// clear "Model not configured" error and no fallback when a desk key is empty.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveDotModel, DotModelError } from '../src/server/dot-model.js';
import { deskKeyEnvName } from '../src/shared/dot-model.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  DirectModel,
  DirectThreadStore,
} from '../src/server/direct-model/index.js';
import type { Config } from '../src/server/research.js';

const SHARED = 'shared-stub-key';
const DESK = 'desk-stub-key';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('resolveDotModel', () => {
  const config = { apiKey: SHARED, model: 'cadis-free' };
  it('uses the server key and model for a Dot without a desk', () => {
    expect(resolveDotModel({}, config, {})).toEqual({
      model: 'cadis-free',
      apiKey: SHARED,
      desk: null,
      headers: {},
    });
    expect(resolveDotModel({ model: 'cadis' }, config, {}).model).toBe('cadis');
    expect(resolveDotModel({}, { apiKey: SHARED }, {}).model).toBe(
      'cadis-cursor',
    );
  });
  it('uses the desk key and X-Cadis-Desk header per Dot', () => {
    const env = { CADIS_API_KEY_DEVVY: DESK, CADIS_API_KEY_SEC: 'other' };
    expect(resolveDotModel({ desk: 'devvy' }, config, env)).toEqual({
      model: 'cadis-free',
      apiKey: DESK,
      desk: 'devvy',
      headers: { 'X-Cadis-Desk': 'devvy' },
    });
    expect(
      resolveDotModel({ desk: 'sec', model: 'cadis' }, config, env),
    ).toMatchObject({
      apiKey: 'other',
      model: 'cadis',
      headers: { 'X-Cadis-Desk': 'sec' },
    });
  });
  it('fails clearly with no fallback when the desk key is empty', () => {
    for (const env of [
      {},
      { CADIS_API_KEY_DEVVY: '' },
      { CADIS_API_KEY_DEVVY: '  ' },
    ]) {
      expect(() => resolveDotModel({ desk: 'devvy' }, config, env)).toThrow(
        DotModelError,
      );
      expect(() => resolveDotModel({ desk: 'devvy' }, config, env)).toThrow(
        /^Model not configured for desk "devvy": set CADIS_API_KEY_DEVVY/,
      );
    }
  });
  it('maps desk names to env names', () => {
    expect(deskKeyEnvName('devvy')).toBe('CADIS_API_KEY_DEVVY');
    expect(deskKeyEnvName('dev-ops')).toBe('CADIS_API_KEY_DEV_OPS');
  });
});

describe('per-Dot model storage and API', () => {
  it('persists model and desk on a Dot, including after reopening the database', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'dot-model-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'w.sqlite');
    const first = new WorkspaceStore(path, 'owner');
    const dot = first.dots()[0];
    expect(dot.model ?? null).toBeNull();
    first.setDotModel(dot.id, { model: 'cadis', desk: 'devvy' });
    first.setDotModel(dot.id, { model: undefined });
    first.close();
    const second = new WorkspaceStore(path, 'owner');
    expect(second.dot(dot.id)).toMatchObject({ model: 'cadis', desk: 'devvy' });
    second.setDotModel(dot.id, { model: null, desk: null });
    expect(second.dot(dot.id)).toMatchObject({ model: null, desk: null });
    second.close();
  });
});

async function stub() {
  const calls: { model: string; auth?: string; desk?: string }[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    calls.push({
      model: JSON.parse(raw).model,
      auth: request.headers.authorization,
      desk: request.headers['x-cadis-desk'] as string | undefined,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
  };
}

function fixture(url: string) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const threads = new DirectThreadStore(':memory:');
  const direct = new DirectModel({
    store,
    workspace,
    threads,
    model: {
      apiKey: SHARED,
      baseUrl: url,
      model: 'cadis-free',
      fallbackModel: 'cadis',
    },
    backoffMs: 0,
    log: () => undefined,
  });
  const config: Config = { mode: 'live', baseUrl: url, apiKey: SHARED };
  const runner = new Runner(store, config);
  const app = createApp({ store, runner, config, direct });
  cleanups.push(() => {
    store.close();
    workspace.close();
    threads.close();
  });
  return { app, workspace };
}
const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('per-Dot model on the direct-model path', () => {
  it('sends the Dot model, desk key and X-Cadis-Desk header', async () => {
    vi.stubEnv('CADIS_API_KEY_DEVVY', DESK);
    const endpoint = await stub();
    const { app, workspace } = fixture(endpoint.url);
    const dot = workspace.dots()[0];
    const set = await app.request(
      `/api/dots/${dot.id}/model`,
      send('PUT', { model: 'cadis', desk: 'Devvy' }),
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ model: 'cadis', desk: 'devvy' });
    const thread = workspace.bindThread('t1', dot.id, 'Desk');
    const reply = await app.request(
      `/api/conversations/${thread.id}/messages`,
      send('POST', { content: 'hi' }),
    );
    expect(reply.status).toBe(201);
    expect(endpoint.calls).toEqual([
      { model: 'cadis', auth: `Bearer ${DESK}`, desk: 'devvy' },
    ]);
  });

  it('returns "Model not configured" without calling the model when the desk key is empty', async () => {
    vi.stubEnv('CADIS_API_KEY_DEVVY', '');
    const endpoint = await stub();
    const { app, workspace } = fixture(endpoint.url);
    const dot = workspace.dots()[0];
    workspace.setDotModel(dot.id, { desk: 'devvy' });
    const thread = workspace.bindThread('t2', dot.id, 'Desk');
    const reply = await app.request(
      `/api/conversations/${thread.id}/messages`,
      send('POST', { content: 'hi' }),
    );
    expect(reply.status).toBe(502);
    expect(((await reply.json()) as { error: string }).error).toMatch(
      /^Model not configured for desk "devvy"/,
    );
    expect(endpoint.calls).toHaveLength(0);
  });

  it('rejects models outside the allowlist and bad desk names', async () => {
    const endpoint = await stub();
    const { app, workspace } = fixture(endpoint.url);
    const id = workspace.dots()[0].id;
    for (const body of [
      { model: 'gpt-x' },
      { desk: 'bad desk' },
      { desk: '../x' },
      { other: 1 },
    ])
      expect(
        (await app.request(`/api/dots/${id}/model`, send('PUT', body))).status,
      ).toBe(400);
    expect(
      (
        await app.request(
          '/api/dots/nope/model',
          send('PUT', { model: 'cadis' }),
        )
      ).status,
    ).toBe(404);
  });

  it('renames and re-instructs a Dot in direct mode without touching other fields', async () => {
    const endpoint = await stub();
    const { app, workspace } = fixture(endpoint.url);
    const before = workspace.dots()[0];
    workspace.setDotModel(before.id, { model: 'cadis', desk: 'devvy' });
    const edit = await app.request(
      `/api/dots/${before.id}`,
      send('PATCH', { name: ' Desk Dot ', instructions: 'Handle the desk.' }),
    );
    expect(edit.status).toBe(200);
    const after = workspace.dot(before.id)!;
    expect(after).toMatchObject({
      name: 'Desk Dot',
      instructions: 'Handle the desk.',
      researchAllowed: before.researchAllowed,
      memoryAllowed: before.memoryAllowed,
      spaceId: before.spaceId,
      spaceIds: before.spaceIds,
      model: 'cadis',
      desk: 'devvy',
    });
    for (const body of [
      { name: '', instructions: 'Handle the desk.' },
      { name: 'x'.repeat(41), instructions: 'Handle the desk.' },
      { name: 'Ok', instructions: 'no' },
      { name: 'Ok', instructions: 'Handle it.', researchAllowed: false },
      { name: 'Ok' },
    ])
      expect(
        (await app.request(`/api/dots/${before.id}`, send('PATCH', body)))
          .status,
      ).toBe(400);
    expect(
      (
        await app.request(
          '/api/dots/nope',
          send('PATCH', { name: 'Ok', instructions: 'Handle it.' }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/dots/${before.id}`, send('PUT', {}))).status,
    ).toBe(501);
    expect(
      (await app.request(`/api/dots/${before.id}`, send('DELETE', {}))).status,
    ).toBe(501);
  });
});
