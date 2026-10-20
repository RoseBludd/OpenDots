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
  const names = () => ws.dots().map((dot) => dot.name);
  expect(names().slice(-3)).toEqual(['a', 'b', 'c']);
  ws.setDotLook(c.id, { pinned: true });
  expect(ws.dots()[0].id).toBe(c.id);
  ws.setDotOrder([b.id, a.id, c.id]);
  expect(ws.dots().map((dot) => dot.id)).toEqual([c.id, b.id, a.id]);
  ws.setDotLook(a.id, { pinned: true });
  expect(ws.dots().map((dot) => dot.id)).toEqual([c.id, a.id, b.id]);
  ws.setDotOrder([a.id, c.id]);
  expect(ws.dots()[0].id).toBe(a.id);
  expect(ws.dots()[1].id).toBe(c.id);
});
