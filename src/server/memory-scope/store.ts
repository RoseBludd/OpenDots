// Per-Dot memory scope (WO-02). A memory with no row here is global (visible to
// every Dot); a row binds it to one Dot. Kept in its own table so the memories
// table and Store (store.ts) are unchanged, following the ComputerStore pattern
// of a sub-store on WorkspaceStore's database.
//
// Scope model ported from AgentConnect (RoseBludd/agentconnect,
// packages/daemon/src/memory-plugin/outbox.ts: memories carry
// `scope: { kind: 'agent', key: canonicalAgentMemoryKey(agentId) }`; anything
// without an agent scope is user-wide).
import type { DatabaseSync } from 'node:sqlite';
import type { Memory } from '../../shared/types.js';

export class MemoryScopeStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS memory_scopes(memoryId TEXT PRIMARY KEY, dotId TEXT NOT NULL)',
    );
  }
  /** null makes the memory global again. */
  set(memoryId: string, dotId: string | null) {
    if (dotId === null)
      this.db
        .prepare('DELETE FROM memory_scopes WHERE memoryId=?')
        .run(memoryId);
    else
      this.db
        .prepare(
          'INSERT INTO memory_scopes VALUES (?, ?) ON CONFLICT(memoryId) DO UPDATE SET dotId=excluded.dotId',
        )
        .run(memoryId, dotId);
  }
  private all(): Map<string, string> {
    return new Map(
      this.db
        .prepare('SELECT memoryId, dotId FROM memory_scopes')
        .all()
        .map((row) => [String(row.memoryId), String(row.dotId)]),
    );
  }
  scopeOf(memoryId: string): string | null {
    const row = this.db
      .prepare('SELECT dotId FROM memory_scopes WHERE memoryId=?')
      .get(memoryId);
    return typeof row?.dotId === 'string' ? row.dotId : null;
  }
  /** Adds `dotId` (null = global) to each memory, for owner views. */
  annotate(memories: Memory[]): Memory[] {
    const scopes = this.all();
    return memories.map((memory) => ({
      ...memory,
      dotId: scopes.get(memory.id) ?? null,
    }));
  }
  /**
   * What one Dot may read: globals plus its own. `null` means "no Dot" (tasks
   * outside a conversation) and sees globals only. Another Dot's memories,
   * including those of a deleted Dot, are never returned.
   */
  visible(memories: Memory[], dotId: string | null): Memory[] {
    return this.annotate(memories).filter(
      (memory) => memory.dotId === null || memory.dotId === dotId,
    );
  }
}
