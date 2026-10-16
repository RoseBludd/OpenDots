// Local thread history for direct-model conversations. Lives in the same SQLite
// database as WorkspaceStore (workspace.ts), whose thread_bindings table still
// owns conversation ids, Dots and ownership; this table only adds the messages
// that Intelligence would otherwise keep.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './client.js';

export interface StoredMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  createdAt: number;
}

export class DirectThreadStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS direct_messages(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS direct_messages_thread ON direct_messages(threadId, createdAt);`);
  }
  close() {
    this.db.close();
  }
  messages(threadId: string): StoredMessage[] {
    return this.db
      .prepare(
        'SELECT * FROM direct_messages WHERE threadId=? ORDER BY createdAt, rowid',
      )
      .all(threadId) as unknown as StoredMessage[];
  }
  /** Recent turns for the model, bounded by count and characters. */
  history(threadId: string, limit = 24, maxChars = 24_000): ChatMessage[] {
    const recent = this.messages(threadId).slice(-limit);
    const result: ChatMessage[] = [];
    let used = 0;
    for (const message of recent.reverse()) {
      used += message.content.length;
      if (used > maxChars && result.length) break;
      result.unshift({ role: message.role, content: message.content });
    }
    return result;
  }
  append(
    threadId: string,
    role: StoredMessage['role'],
    content: string,
    model: string | null = null,
  ): StoredMessage {
    const value: StoredMessage = {
      id: randomUUID(),
      threadId,
      role,
      content,
      model,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO direct_messages VALUES (?, ?, ?, ?, ?, ?)')
      .run(value.id, threadId, role, content, model, value.createdAt);
    return value;
  }
}
