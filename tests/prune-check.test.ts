import { describe, it, expect } from 'vitest';
import { DirectThreadStore } from '../src/server/direct-model/threads.js';

describe('direct_messages prune', () => {
  it('keeps only the last N rows per thread on append', () => {
    const store = new DirectThreadStore(':memory:');
    const threadId = 'thread-1';
    for (let i = 0; i < 40; i++) store.append(threadId, i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`);
    const rows = store.messages(threadId);
    expect(rows.length).toBe(24);
    expect(rows[0].content).toBe('msg-16');
    expect(rows[rows.length - 1].content).toBe('msg-39');
    store.close();
  });
});
