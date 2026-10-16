import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { HandoffService } from '../src/server/handoff/index.js';

const resources: { store: Store; workspace: WorkspaceStore; dir: string }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-handoff-'));
  const path = join(dir, 'handoff.sqlite');
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  resources.push({ store, workspace, dir });
  return { store, workspace, service: new HandoffService(store, workspace) };
}
afterEach(() =>
  resources.splice(0).forEach(({ store, workspace, dir }) => {
    store.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }),
);

describe('Dot registry', () => {
  it('lists every Dot with capabilities and spaces', () => {
    const { service, workspace } = fixture();
    const space = workspace.createSpace('Design', 'Design decisions');
    workspace.createDot(space.id, 'Scout', 'Be concise', false, true);
    const registry = service.registry();
    const scout = registry.find((r) => r.name === 'Scout');
    expect(scout).toBeDefined();
    expect(scout!.summary).toBe('Be concise');
    expect(scout!.researchAllowed).toBe(false);
    expect(scout!.memoryAllowed).toBe(true);
    expect(scout!.spaces).toEqual([{ id: space.id, name: 'Design' }]);
    expect(scout!.skillDeliveryEnabled).toBe(false);
  });

  it('truncates long instruction summaries for the listing', () => {
    const { service, workspace } = fixture();
    const space = workspace.createSpace('Ops', '');
    workspace.createDot(space.id, 'Writer', 'x'.repeat(300), true, true);
    const entry = service.registry().find((r) => r.name === 'Writer');
    expect(entry!.summary).toHaveLength(220);
    expect(entry!.summary.endsWith('...')).toBe(true);
  });
});

describe('handoff_to', () => {
  it('enqueues a task in the target Dot thread through the normal queue', () => {
    const { service, workspace, store } = fixture();
    const space = workspace.createSpace('Design', '');
    const scout = workspace.createDot(space.id, 'Scout', 'Be concise', false, true);
    const writer = workspace.createDot(space.id, 'Writer', 'Write drafts', true, true);
    const thread = workspace.bindThread('thread-1', writer.id, 'Draft thread');

    const result = service.handoffTo(writer.id, thread.id, '  Summarize the findings  ', scout.id);

    expect(result.task.threadId).toBe(thread.id);
    expect(result.handoff.fromDot).toBe(scout.id);
    expect(result.handoff.toDot).toBe(writer.id);
    expect(result.handoff.note).toBe('Summarize the findings');
    expect(store.task(result.task.id)?.status).toBe('queued');
    expect(store.task(result.task.id)?.prompt).toContain('Handoff from Scout');
    expect(store.task(result.task.id)?.prompt).toContain('Summarize the findings');
    expect(workspace.taskThread(result.task.id)).toBe(thread.id);
  });

  it('creates the target thread when it does not exist yet', () => {
    const { service, workspace, store } = fixture();
    const space = workspace.createSpace('Design', '');
    const scout = workspace.createDot(space.id, 'Scout', 'Be concise', false, true);
    const writer = workspace.createDot(space.id, 'Writer', 'Write drafts', true, true);

    const result = service.handoffTo(writer.id, '', 'Do the research', scout.id);
    expect(result.task.threadId).toBeTruthy();
    expect(workspace.conversations()).toHaveLength(1);
    expect(workspace.conversations()[0].dotId).toBe(writer.id);
    expect(workspace.taskThread(result.task.id)).toBe(result.task.threadId);
    expect(store.task(result.task.id)?.prompt).toContain('Handoff from Scout');
  });

  it('errors cleanly when the target Dot is unknown', () => {
    const { service, workspace } = fixture();
    const space = workspace.createSpace('Design', '');
    const scout = workspace.createDot(space.id, 'Scout', 'Be concise', false, true);
    expect(() => service.handoffTo('missing', '', 'note', scout.id)).toThrow(
      'Target Dot not found.',
    );
  });

  it('errors cleanly when the note is empty', () => {
    const { service, workspace } = fixture();
    const space = workspace.createSpace('Design', '');
    const scout = workspace.createDot(space.id, 'Scout', 'Be concise', false, true);
    const writer = workspace.createDot(space.id, 'Writer', 'Write drafts', true, true);
    expect(() => service.handoffTo(writer.id, '', '   ', scout.id)).toThrow(
      'A handoff note is required.',
    );
  });

  it('rejects a handoff to a thread owned by a different Dot', () => {
    const { service, workspace } = fixture();
    const space = workspace.createSpace('Design', '');
    const scout = workspace.createDot(space.id, 'Scout', 'Be concise', false, true);
    const writer = workspace.createDot(space.id, 'Writer', 'Write drafts', true, true);
    const other = workspace.createDot(space.id, 'Other', 'Other', true, true);
    const thread = workspace.bindThread('thread-1', other.id, 'Other thread');
    expect(() => service.handoffTo(writer.id, thread.id, 'note', scout.id)).toThrow(
      'belongs to a different Dot',
    );
  });
});