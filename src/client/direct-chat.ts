// Client for direct-model mode (no Intelligence): talks to the conversation
// routes from src/server/direct-model/routes.ts (WO-07) and keeps a small,
// subscribable session so the chat panel can render streamed replies with the
// existing ChatTranscript component.
import type { Message } from '@ag-ui/core';
import { ApiError, authHeaders } from './api';
import type { WorkspaceState } from '../shared/types';

export interface StoredMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  createdAt: number;
}

/** True when the server runs Dots on the model directly (GET /api/workspace). */
export function isDirectMode(workspace?: Pick<WorkspaceState, 'mode'>) {
  return workspace?.mode === 'direct-model';
}

/** Model shown for a Dot: its own choice (WO-03), else the server default. */
export function dotModelLabel(
  dot: { model?: string | null },
  workspace?: Pick<WorkspaceState, 'model'>,
) {
  return dot.model || workspace?.model?.model || 'server default';
}

export const DIRECT_MODE_NOTE =
  'Voice, computers and pages need Intelligence. This server runs Dots on the model directly, so chat and scheduled tasks work here.';

const toMessage = (message: StoredMessage): Message =>
  ({ id: message.id, role: message.role, content: message.content }) as Message;

async function failure(response: Response): Promise<never> {
  const data = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new ApiError(
    data?.error ?? `Request failed (${response.status}).`,
    response.status,
  );
}

export async function loadHistory(
  threadId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Message[]> {
  const response = await fetchImpl(
    `/api/conversations/${encodeURIComponent(threadId)}/messages`,
    { credentials: 'include', headers: authHeaders() },
  );
  if (!response.ok) await failure(response);
  const data = (await response.json()) as { messages: StoredMessage[] };
  return data.messages.map(toMessage);
}

/** Sends one message and streams the reply (SSE: delta, done, error). */
export async function streamReply(
  threadId: string,
  content: string,
  options: {
    onDelta: (text: string) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<{ message: StoredMessage; model: string }> {
  const response = await (options.fetchImpl ?? fetch)(
    `/api/conversations/${encodeURIComponent(threadId)}/messages`,
    {
      method: 'POST',
      credentials: 'include',
      signal: options.signal,
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ content, stream: true }),
    },
  );
  if (!response.ok) await failure(response);
  if (!response.body) throw new Error('The reply could not be read.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return undefined;
    const value = JSON.parse(data.join('\n')) as {
      text?: string;
      error?: string;
      message?: StoredMessage;
      model?: string;
    };
    if (event === 'delta' && value.text) options.onDelta(value.text);
    if (event === 'error')
      throw new Error(value.error ?? 'The reply failed. Please try again.');
    if (event === 'done' && value.message)
      return { message: value.message, model: value.model ?? '' };
    return undefined;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const result = handle(block);
      if (result) {
        await reader.cancel().catch(() => undefined);
        return result;
      }
    }
    if (done) {
      const result = buffer.trim() ? handle(buffer) : undefined;
      if (result) return result;
      throw new Error('The reply was interrupted. Please try again.');
    }
  }
}

export interface DirectChatSnapshot {
  messages: Message[];
  loaded: boolean;
  running: boolean;
  error: string;
  model: string;
}

/** Thread state for one direct-model conversation. */
export class DirectChatSession {
  private snapshot: DirectChatSnapshot = {
    messages: [],
    loaded: false,
    running: false,
    error: '',
    model: '',
  };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  constructor(
    readonly threadId: string,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}
  get = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<DirectChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  async load() {
    try {
      this.set({
        messages: await loadHistory(this.threadId, this.fetchImpl),
        loaded: true,
        error: '',
      });
    } catch (error) {
      this.set({
        error:
          error instanceof Error
            ? error.message
            : 'Conversation could not load.',
      });
    }
  }
  /** Resolves false when the turn failed (the caller can restore the draft). */
  async send(text: string): Promise<boolean> {
    const content = text.trim();
    if (!content || this.snapshot.running || !this.snapshot.loaded)
      return false;
    const before = this.snapshot.messages;
    const pending = `pending-${Date.now()}`;
    const user = { id: `${pending}-user`, role: 'user', content } as Message;
    let reply = '';
    const show = () =>
      this.set({
        messages: [
          ...before,
          user,
          ...(reply
            ? [{ id: pending, role: 'assistant', content: reply } as Message]
            : []),
        ],
      });
    this.controller = new AbortController();
    this.set({ running: true, error: '' });
    show();
    try {
      const done = await streamReply(this.threadId, content, {
        signal: this.controller.signal,
        fetchImpl: this.fetchImpl,
        onDelta: (piece) => {
          reply += piece;
          show();
        },
      });
      this.set({
        messages: [...before, user, toMessage(done.message)],
        model: done.model,
        running: false,
      });
      return true;
    } catch (error) {
      const stopped = this.controller.signal.aborted;
      this.set({
        messages: before,
        running: false,
        error: stopped
          ? 'Stopped. Nothing from this turn was saved.'
          : error instanceof Error
            ? error.message
            : 'The turn failed. Please try again.',
      });
      return false;
    }
  }
  stop() {
    this.controller?.abort();
  }
}
