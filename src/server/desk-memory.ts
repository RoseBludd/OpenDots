// Desk-scoped remember/recall, reusing the same memory table and scopes as the
// Memories API (store.ts, workspace.ts memoryScopes) rather than a parallel store.
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';

/** A durable memory scoped to one Dot. Skips exact duplicates already visible to it. */
export function rememberMemory(
  store: Store,
  workspace: WorkspaceStore,
  dotId: string,
  raw: string,
): string {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) return 'Nothing to remember: the text was empty.';
  const visible = workspace.memoryScopes.visible(store.memories(), dotId);
  if (visible.some((memory) => memory.text.toLowerCase() === text.toLowerCase()))
    return 'Already remembered.';
  const memory = store.saveMemory(text);
  workspace.memoryScopes.set(memory.id, dotId);
  return `Remembered (memory ${memory.id.slice(0, 8)}).`;
}

/** Visible memories ranked by shared query words; an empty query lists the latest. */
export function recallMemory(
  store: Store,
  workspace: WorkspaceStore,
  dotId: string,
  query: string,
): string {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
  const visible = workspace.memoryScopes.visible(store.memories(), dotId);
  const ranked = visible
    .map((memory) => ({
      memory,
      score: words.filter((w) => memory.text.toLowerCase().includes(w)).length,
    }))
    .filter((r) => !words.length || r.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
    .slice(0, 10);
  return ranked.length
    ? ranked.map((r) => `- ${r.memory.text}`).join('\n')
    : 'No matching memories.';
}
