// Sidebar order: pinned Dots first, then the stored drag order, then creation order.
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';

const make = (ws: WorkspaceStore, name: string) =>
  ws.createDot(
    ws.spaces()[0].id,
    name,
    'x',
    true,
    true,
    [ws.spaces()[0].id],
    null,
    false,
  );

it('lists pinned Dots first and keeps a stored drag order', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const a = make(ws, 'a');
  const b = make(ws, 'b');
  const c = make(ws, 'c');
  const mine = new Set([a.id, b.id, c.id]);
  const ids = () =>
    ws
      .dots()
      .map((dot) => dot.id)
      .filter((id) => mine.has(id));
  expect(ids()).toEqual([a.id, b.id, c.id]);
  ws.setDotLook(c.id, { pinned: true });
  expect(ids()[0]).toBe(c.id);
  ws.setDotOrder([b.id, a.id, c.id]);
  expect(ids()).toEqual([c.id, b.id, a.id]);
  ws.setDotLook(a.id, { pinned: true });
  expect(ids()).toEqual([a.id, c.id, b.id]);
  ws.setDotOrder([a.id, c.id]);
  expect(ids().slice(0, 2)).toEqual([a.id, c.id]);
});
