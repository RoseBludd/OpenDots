// Per-Dot memory scope (WO-02): Dot A cannot read Dot B's memories, globals are
// visible to every Dot, and seat/standing-rule import is capped and idempotent.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  DirectModel,
  DirectThreadStore,
} from '../src/server/direct-model/index.js';
import {
  dotForDesk,
  importSeatMemories,
  normalizeMemory,
  rules,
  sections,
} from '../src/server/memory-scope/import.js';
import type { Dot } from '../src/shared/types.js';
import { boundedText } from '../src/server/memory-scope/bounded.js';
import type { Config } from '../src/server/research.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-scope-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function twoDots(workspace: WorkspaceStore) {
  const space = workspace.spaces()[0].id;
  const a = workspace.dots()[0];
  const b = workspace.createDot(
    space,
    'Bee',
    'Second Dot for scope tests.',
    true,
    true,
  );
  return { a, b };
}

describe('memory scope', () => {
  it('migrates an existing database with every old memory global', () => {
    const path = join(tempDir(), 'od.sqlite');
    const store = new Store(path);
    const old = store.saveMemory('An old preference');
    // A database from before WO-02 has no memory_scopes table.
    const raw = new DatabaseSync(path);
    expect(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE name='memory_scopes'")
        .get(),
    ).toBeUndefined();
    raw.close();
    const workspace = new WorkspaceStore(path, 'owner');
    const { a, b } = twoDots(workspace);
    for (const dot of [a, b])
      expect(workspace.memoryScopes.visible(store.memories(), dot.id)).toEqual([
        { ...old, dotId: null },
      ]);
    store.close();
    workspace.close();
  });

  it('keeps Dot A from reading Dot B and shows globals to all', () => {
    const path = join(tempDir(), 'od.sqlite');
    const store = new Store(path);
    const workspace = new WorkspaceStore(path, 'owner');
    const { a, b } = twoDots(workspace);
    const global = store.saveMemory('Standing rule: secrets never in args');
    const mineA = store.saveMemory('A only');
    const mineB = store.saveMemory('B only');
    workspace.memoryScopes.set(mineA.id, a.id);
    workspace.memoryScopes.set(mineB.id, b.id);
    const texts = (dotId: string | null) =>
      workspace.memoryScopes
        .visible(store.memories(), dotId)
        .map((m) => m.text)
        .sort();
    expect(texts(a.id)).toEqual([
      'A only',
      'Standing rule: secrets never in args',
    ]);
    expect(texts(b.id)).toEqual([
      'B only',
      'Standing rule: secrets never in args',
    ]);
    expect(texts(null)).toEqual(['Standing rule: secrets never in args']);
    workspace.deleteDot(b.id);
    expect(texts(a.id)).not.toContain('B only');
    expect(texts(null)).not.toContain('B only');
    workspace.memoryScopes.set(mineA.id, null);
    expect(texts(null)).toContain('A only');
    expect(global.id).toBeTruthy();
    store.close();
    workspace.close();
  });
});

async function stub() {
  const systems: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    systems.push(JSON.parse(raw).messages[0].content);
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
    systems,
  };
}
const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('memory API and Dot prompts', () => {
  async function fixture() {
    const endpoint = await stub();
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const threads = new DirectThreadStore(':memory:');
    const direct = new DirectModel({
      store,
      workspace,
      threads,
      model: { apiKey: 'stub', baseUrl: endpoint.url, model: 'cadis-free' },
      backoffMs: 0,
      log: () => undefined,
    });
    const config: Config = {
      mode: 'live',
      baseUrl: endpoint.url,
      apiKey: 'stub',
    };
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
    return { endpoint, store, workspace, runner, app, ...twoDots(workspace) };
  }

  it('scopes memories through ?dotId= and annotates state', async () => {
    const { app, a, b } = await fixture();
    expect(
      (
        await app.request(
          '/api/memories',
          send('POST', { text: 'global rule' }),
        )
      ).status,
    ).toBe(201);
    const created = await app.request(
      '/api/memories',
      send('POST', { text: 'secret of A', dotId: a.id }),
    );
    expect(await created.json()).toMatchObject({
      text: 'secret of A',
      dotId: a.id,
    });
    await app.request(
      '/api/memories',
      send('POST', { text: 'secret of B', dotId: b.id }),
    );
    const list = async (query: string) =>
      (
        (await (await app.request(`/api/memories${query}`)).json()) as {
          memories: { text: string }[];
        }
      ).memories
        .map((m) => m.text)
        .sort();
    expect(await list(`?dotId=${a.id}`)).toEqual([
      'global rule',
      'secret of A',
    ]);
    expect(await list(`?dotId=${b.id}`)).toEqual([
      'global rule',
      'secret of B',
    ]);
    expect(await list('')).toEqual([
      'global rule',
      'secret of A',
      'secret of B',
    ]);
    expect((await app.request('/api/memories?dotId=missing')).status).toBe(404);
    expect(
      (
        await app.request(
          '/api/memories',
          send('POST', { text: 'x', dotId: 'missing' }),
        )
      ).status,
    ).toBe(404);
    const state = (await (await app.request('/api/state')).json()) as {
      memories: { text: string; dotId: string | null }[];
    };
    expect(state.memories.find((m) => m.text === 'secret of B')?.dotId).toBe(
      b.id,
    );
  });

  it('sends a Dot only global and its own memories, and tasks without a Dot only globals', async () => {
    const { app, endpoint, store, workspace, runner, a, b } = await fixture();
    await app.request('/api/memories', send('POST', { text: 'GLOBAL-RULE' }));
    await app.request(
      '/api/memories',
      send('POST', { text: 'A-NOTE', dotId: a.id }),
    );
    await app.request(
      '/api/memories',
      send('POST', { text: 'B-NOTE', dotId: b.id }),
    );
    const thread = workspace.bindThread('ta', a.id, 'A thread');
    await app.request(
      `/api/conversations/${thread.id}/messages`,
      send('POST', { content: 'hi' }),
    );
    expect(endpoint.systems[0]).toContain('GLOBAL-RULE');
    expect(endpoint.systems[0]).toContain('A-NOTE');
    expect(endpoint.systems[0]).not.toContain('B-NOTE');
    store.createTask('An unbound task');
    await runner.tick();
    expect(endpoint.systems[1]).toContain('GLOBAL-RULE');
    expect(endpoint.systems[1]).not.toContain('A-NOTE');
    expect(endpoint.systems[1]).not.toContain('B-NOTE');
  });
});

describe('seat and standing-rule import', () => {
  function setup() {
    const dir = tempDir();
    const seats = join(dir, 'seats');
    mkdirSync(join(seats, 'devvy'), { recursive: true });
    mkdirSync(join(seats, 'ghost'), { recursive: true });
    writeFileSync(
      join(seats, 'devvy', 'BRIEF.md'),
      '# devvy. seat\n## Persona\nDevelopment seat.\n## Focus\nShip WO-07.\n',
    );
    writeFileSync(
      join(seats, 'devvy', 'log.md'),
      `## Log\n${'x'.repeat(5000)}\n## Later\nmore\n`,
    );
    writeFileSync(join(seats, 'sec.md'), '## Role\nReview only.\n');
    writeFileSync(join(seats, 'ghost', 'BRIEF.md'), '## Nobody\nNo Dot.\n');
    const rulesFile = join(dir, 'standing-rules.md');
    writeFileSync(
      rulesFile,
      '# Rules\n1. No sends without OK.\n2. Secrets never in args,\n   use env files.\n- CADIS only.\n',
    );
    const path = join(dir, 'od.sqlite');
    const store = new Store(path);
    const workspace = new WorkspaceStore(path, 'owner');
    const space = workspace.spaces()[0].id;
    const devvy = workspace.createDot(
      space,
      'devvy.',
      'Dev seat Dot.',
      true,
      true,
    );
    const sec = workspace.createDot(
      space,
      'Security',
      'Review Dot.',
      true,
      true,
    );
    workspace.setDotModel(sec.id, { desk: 'sec' });
    store.saveMemory('A personal preference');
    cleanups.push(() => {
      store.close();
      workspace.close();
    });
    return { seats, rulesFile, store, workspace, devvy, sec };
  }

  it('parses rules and sections', () => {
    expect(rules('1. One\n2. Two\n   continued\n- Three\n')).toEqual([
      'One',
      'Two continued',
      'Three',
    ]);
    expect(sections('# Title\n## A\ntext a\n## Empty\n## B\ntext b')).toEqual([
      '## A\ntext a',
      '## B\ntext b',
    ]);
  });

  it('dry-runs, then imports capped Dot-scoped seat memories and global rules idempotently', () => {
    const { seats, rulesFile, store, workspace, devvy, sec } = setup();
    const options = {
      seatsDir: seats,
      rulesFile,
      maxPerDesk: 3,
      maxBytes: 200,
    };
    const dry = importSeatMemories(store, workspace, options);
    expect(dry.apply).toBe(false);
    expect(store.memories()).toHaveLength(1);
    expect(dry.globals.new).toBe(3);
    const applied = importSeatMemories(store, workspace, {
      ...options,
      apply: true,
    });
    expect(applied.unmatchedDesks).toEqual(['ghost']);
    expect(applied.otherGlobals).toBe(1);
    const devvyRow = applied.desks.find((d) => d.desk === 'devvy')!;
    expect(devvyRow).toMatchObject({
      dotId: devvy.id,
      matchedBy: 'name',
      new: 3,
      truncated: 1,
    });
    expect(applied.desks.find((d) => d.desk === 'sec')).toMatchObject({
      dotId: sec.id,
      matchedBy: 'desk',
      new: 1,
    });
    const visible = (dotId: string | null) =>
      workspace.memoryScopes.visible(store.memories(), dotId);
    expect(visible(devvy.id).filter((m) => m.dotId === devvy.id)).toHaveLength(
      3,
    );
    expect(
      visible(devvy.id).every((m) => Buffer.byteLength(m.text) <= 200),
    ).toBe(true);
    expect(visible(sec.id).map((m) => m.text)).not.toContain(
      '## Persona\nDevelopment seat.',
    );
    expect(
      visible(null)
        .map((m) => m.text)
        .sort(),
    ).toEqual(
      [
        'A personal preference',
        'CADIS only.',
        'No sends without OK.',
        'Secrets never in args, use env files.',
      ].sort(),
    );
    const again = importSeatMemories(store, workspace, {
      ...options,
      apply: true,
    });
    expect(again.globals).toEqual({ new: 0, skippedDuplicate: 3 });
    expect(again.desks.every((d) => d.new === 0)).toBe(true);
  });

  it('matches host Dot names by desk field, then name pattern', () => {
    const dot = (name: string, desk: string | null = null) =>
      ({ id: name, name, desk }) as unknown as Dot;
    const dots = [
      dot('oppi. (desk)'),
      dot('Devvy.'),
      dot('Lead'),
      dot('Ops (Desk)'),
      dot('Other', 'lead'),
    ];
    expect(dotForDesk(dots, 'oppi')?.dot.name).toBe('oppi. (desk)');
    expect(dotForDesk(dots, 'devvy')?.matchedBy).toBe('name');
    expect(dotForDesk(dots, 'ops')?.dot.name).toBe('Ops (Desk)');
    expect(dotForDesk(dots, 'lead')).toMatchObject({
      matchedBy: 'desk',
      dot: { name: 'Other' },
    });
    expect(dotForDesk(dots, 'opp')).toBeUndefined();
    expect(dotForDesk([dot('oppi. (desk) old')], 'oppi')).toBeUndefined();
    expect(normalizeMemory('  2.  No   SENDS without OK. ')).toBe(
      normalizeMemory('- no sends without ok.'),
    );
  });

  it('skips standing rules already among globals and sets empty desks only with --set-desk', () => {
    const { seats, rulesFile, store, workspace, devvy, sec } = setup();
    store.saveMemory('  cadis   ONLY. ');
    const host = workspace.createDot(
      workspace.spaces()[0].id,
      'oppi. (desk)',
      'Host desk Dot.',
      true,
      true,
    );
    mkdirSync(join(seats, 'oppi'));
    writeFileSync(join(seats, 'oppi', 'BRIEF.md'), '## Role\nRuns the desk.\n');
    const base = { seatsDir: seats, rulesFile, apply: true };
    const withoutFlag = importSeatMemories(store, workspace, base);
    expect(withoutFlag.globals).toEqual({ new: 2, skippedDuplicate: 1 });
    expect(withoutFlag.desks.every((row) => row.setDesk === null)).toBe(true);
    expect(workspace.dot(host.id)?.desk ?? null).toBeNull();
    expect(
      store.memories().filter((m) => normalizeMemory(m.text) === 'cadis only.'),
    ).toHaveLength(1);
    const dry = importSeatMemories(store, workspace, {
      ...base,
      apply: false,
      setDesk: true,
    });
    expect(dry.desks.find((row) => row.desk === 'oppi')).toMatchObject({
      dotId: host.id,
      setDesk: 'oppi',
      new: 0,
      skippedDuplicate: 1,
    });
    expect(dry.desks.find((row) => row.desk === 'sec')?.setDesk).toBeNull();
    expect(workspace.dot(host.id)?.desk ?? null).toBeNull();
    importSeatMemories(store, workspace, { ...base, setDesk: true });
    expect(workspace.dot(host.id)?.desk).toBe('oppi');
    expect(workspace.dot(devvy.id)?.desk).toBe('devvy');
    expect(workspace.dot(sec.id)?.desk).toBe('sec');
  });

  it('caps text by bytes without splitting UTF-8 characters', () => {
    const text = '€'.repeat(400);
    const capped = boundedText(text, 120);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(120);
    expect(capped).not.toContain('\uFFFD');
    expect(capped).toContain('truncated');
    expect(boundedText('short', 120)).toBe('short');
  });
});
