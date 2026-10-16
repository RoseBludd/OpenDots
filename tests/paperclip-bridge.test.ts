// WO-TWIN-06 contract tests: ported from Hermes gateway contract cases
// (RoseBludd/hermes tests/gateway/test_api_server.py) run against the
// Paperclip wake bridge, matching what the Paperclip hermes_gateway adapter sends.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Config } from '../src/server/research.js';

const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const TOKEN = 'bridge-token-at-least-24-chars-long';
const SESSION = 'paperclip:company:genius-substrates:agent:devvy:issue:abc123';

function bridgeFixture({
  deskMap,
  token,
}: {
  deskMap?: [string, string, string][];
  token?: string | null;
} = {}) {
  const store = new Store(':memory:');
  stores.push(store);
  const runner = new Runner(store, config);
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const space = workspace.createSpace('Desk', 'Desk spaces');
  workspace.createDot(space.id, 'Devvy', 'Desk dot', false, false);
  let deskMapPath: string | undefined;
  if (deskMap) {
    deskMapPath = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'desk-map.tsv');
    writeFileSync(
      deskMapPath,
      `company\tagent\tdot\n${deskMap.map((row) => row.join('\t')).join('\n')}\n`,
    );
  }
  const app = createApp({
    store,
    runner,
    config,
    workspace,
    paperclipBridge: {
      ...(token === null ? {} : { token: token ?? TOKEN }),
      deskMapPath,
    },
  });
  const fetch = (path: string, init: RequestInit = {}, remote = '127.0.0.1') =>
    app.fetch(new Request(`http://localhost${path}`, init), {
      remoteAddress: remote,
    });
  const authed = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'pc-run-1',
      'X-Hermes-Session-Key': SESSION,
    },
    body: JSON.stringify({
      input: 'Wake the desk: file the weekly report.',
      instructions: 'Follow the Paperclip wake instructions exactly.',
    }),
  };
  return { store, runner, workspace, app, fetch, authed };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe('Paperclip wake bridge (Hermes /v1/runs contract)', () => {
  it('answers /health with 200 and no secrets', async () => {
    const { fetch } = bridgeFixture();
    const response = await fetch('/paperclip/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('looks disabled (404) when no bridge token is configured', async () => {
    const { fetch } = bridgeFixture({ token: null });
    expect((await fetch('/paperclip/health')).status).toBe(404);
    expect((await fetch('/paperclip/v1/models')).status).toBe(404);
  });

  it('refuses off-tailnet callers before auth', async () => {
    const { fetch } = bridgeFixture();
    expect((await fetch('/paperclip/health', {}, '203.0.113.9')).status).toBe(
      403,
    );
    expect(
      (
        await fetch(
          '/paperclip/v1/runs',
          { ...json({ input: 'x' }) },
          '192.0.2.10',
        )
      ).status,
    ).toBe(403);
  });

  it('admits loopback and tailnet (100.64.0.0/10) callers', async () => {
    const { fetch } = bridgeFixture();
    expect((await fetch('/paperclip/health', {}, '100.86.225.40')).status).toBe(
      200,
    );
  });

  it('requires the bridge bearer token, not the owner token', async () => {
    const { fetch } = bridgeFixture();
    expect((await fetch('/paperclip/v1/models')).status).toBe(401);
    expect(
      (
        await fetch('/paperclip/v1/models', {
          headers: { Authorization: 'Bearer owner-token' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch('/paperclip/v1/models', {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
  });

  it('lists the cadis-free model in OpenAI shape', async () => {
    const { fetch } = bridgeFixture();
    const response = await fetch('/paperclip/v1/models', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((model) => model.id)).toContain('cadis-free');
  });

  it('creates a task in the mapped desk thread and returns run_id + queued status', async () => {
    const { store, fetch, workspace, authed } = bridgeFixture();
    const response = await fetch('/paperclip/v1/runs', authed);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    const runId = body.run_id as string;
    expect(body.status).toBe('queued');
    expect(body.session_id).toBe(SESSION);
    const threadId = workspace.taskThread(runId);
    expect(threadId).toBeDefined();
    expect(
      workspace.conversations().find((t) => t.id === threadId)?.dotId,
    ).toBe(workspace.dots().find((dot) => dot.name === 'Devvy')?.id);
    expect(store.task(runId)?.prompt).toContain('file the weekly report');
  });

  it('maps through desk-map.tsv when provided', async () => {
    const { fetch, workspace, authed } = bridgeFixture({
      deskMap: [['genius-substrates', 'devvy', 'Devvy']],
    });
    const response = await fetch('/paperclip/v1/runs', authed);
    expect(response.status).toBe(201);
    const runId = ((await response.json()) as Record<string, unknown>)
      .run_id as string;
    const threadId = workspace.taskThread(runId);
    expect(
      workspace.conversations().find((t) => t.id === threadId)?.dotId,
    ).toBe(workspace.dots().find((dot) => dot.name === 'Devvy')?.id);
  });

  it('replays the same run for a repeated Idempotency-Key (no duplicates)', async () => {
    const { store, fetch, authed } = bridgeFixture();
    const first = await fetch('/paperclip/v1/runs', authed);
    const runId = ((await first.json()) as Record<string, unknown>)
      .run_id as string;
    const replay = await fetch('/paperclip/v1/runs', authed);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Record<string, unknown>).run_id).toBe(
      runId,
    );
    expect(store.tasks().filter((task) => task.id === runId)).toHaveLength(1);
  });

  it('returns 404 for an unknown agent and 400 for a missing input', async () => {
    const { fetch, authed } = bridgeFixture();
    const unknownAgent = await fetch('/paperclip/v1/runs', {
      ...authed,
      headers: {
        ...authed.headers,
        'X-Hermes-Session-Key': 'paperclip:company:blockzs:agent:ghost:issue:1',
      },
    });
    expect(unknownAgent.status).toBe(404);
    expect(
      ((await unknownAgent.json()) as { error: { code: string } }).error.code,
    ).toBe('unknown_agent');
    const missingInput = await fetch('/paperclip/v1/runs', {
      ...authed,
      headers: { ...authed.headers, 'X-Hermes-Session-Key': SESSION },
      body: JSON.stringify({ instructions: 'no input' }),
    });
    expect(missingInput.status).toBe(400);
    const noSession = await fetch('/paperclip/v1/runs', {
      ...authed,
      headers: {
        ...authed.headers,
        'X-Hermes-Session-Key': 'paperclip:run:only',
      },
    });
    expect(noSession.status).toBe(404);
  });

  it('polls run status to a terminal state with output', async () => {
    const { runner, fetch, authed } = bridgeFixture();
    const created = await fetch('/paperclip/v1/runs', authed);
    const runId = ((await created.json()) as Record<string, unknown>)
      .run_id as string;
    expect(
      (
        (await (
          await fetch(`/paperclip/v1/runs/${runId}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          })
        ).json()) as Record<string, unknown>
      ).status,
    ).toBe('queued');
    await runner.tick();
    const done = await fetch(`/paperclip/v1/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await done.json()) as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(typeof body.output).toBe('string');
  });

  it("hides runs that are not bound to a bridge-mapped Dot's thread", async () => {
    const { store, fetch } = bridgeFixture();
    const task = store.createTask('Owner-made task', null);
    const response = await fetch(`/paperclip/v1/runs/${task.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it('cancels a run on stop and returns 405 for the event stream', async () => {
    const { fetch, authed } = bridgeFixture();
    const created = await fetch('/paperclip/v1/runs', authed);
    const runId = ((await created.json()) as Record<string, unknown>)
      .run_id as string;
    const stop = await fetch(`/paperclip/v1/runs/${runId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as Record<string, unknown>).status).toBe(
      'cancelled',
    );
    expect(
      (
        await fetch(`/paperclip/v1/runs/${runId}/events`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(405);
  });

  it('returns 404 for unknown runs', async () => {
    const { fetch } = bridgeFixture();
    expect(
      (
        await fetch('/paperclip/v1/runs/run_does_not_exist', {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
  });
});
