// Direct OpenAI-compatible chat client used when Intelligence is not configured.
// Reuses the request contract of research.ts (POST {baseUrl}/chat/completions with
// a Bearer key) and the transport retries of resilient-fetch.ts (5xx, overloads
// hidden in a 200 body, silent first byte). On top of that it retries once on an
// empty reply and can fall back once to OPENAI_FALLBACK_MODEL.
import { resilientFetch } from '../resilient-fetch.js';

export interface DirectModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Tried once after the primary model fails with a retryable error (default unset). */
  fallbackModel?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  signal: AbortSignal;
  /** Receives streamed text as it arrives; enables streaming upstream. */
  onDelta?: (text: string) => void;
  fetch?: typeof fetch;
  /** Backoff between same-model attempts (tests pass 0). */
  backoffMs?: number;
  /** How long an attempt may stay silent before it is retried. */
  firstByteMs?: number;
  log?: (line: string) => void;
}

export interface Completion {
  text: string;
  model: string;
}

/** Failure that a later attempt (or the fallback model) may fix. */
class RetryableError extends Error {}

/** User-facing errors: no provider names, keys or raw upstream bodies. */
export class DirectModelError extends Error {}

const retryableStatus = new Set([408, 429, 500, 502, 503, 504, 529]);

async function readStream(
  response: Response,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const handle = (line: string) => {
    const data = line.replace(/^data:\s?/, '').trim();
    if (!data || data === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const value = event as {
      error?: unknown;
      choices?: { delta?: { content?: unknown } }[];
    };
    if (value.error && !text) throw new RetryableError('upstream error event');
    const piece = value.choices?.[0]?.delta?.content;
    if (typeof piece === 'string' && piece) {
      text += piece;
      onDelta(piece);
    }
  };
  for (;;) {
    signal.throwIfAborted();
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) handle(line);
    }
  }
  if (buffer.startsWith('data:')) handle(buffer);
  return text;
}

async function attempt(
  config: DirectModelConfig,
  model: string,
  messages: ChatMessage[],
  options: CompleteOptions,
  send: typeof fetch,
): Promise<string> {
  const response = await send(
    `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: options.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: config.temperature ?? 0.2,
        max_tokens: config.maxOutputTokens ?? 2200,
        ...(options.onDelta ? { stream: true } : {}),
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (retryableStatus.has(response.status))
      throw new RetryableError(`HTTP ${response.status}`);
    throw new DirectModelError(
      `The model returned HTTP ${response.status}. Check the server's model configuration and key.`,
    );
  }
  const type = response.headers.get('content-type') ?? '';
  if (options.onDelta && type.includes('text/event-stream') && response.body)
    return readStream(response, options.onDelta, options.signal);
  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
    choices?: { message?: { content?: unknown } }[];
  } | null;
  if (data?.error) throw new RetryableError('upstream error body');
  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : '';
  if (text && options.onDelta) options.onDelta(text);
  return text;
}

/**
 * One reply from the configured model. Order: primary model (resilientFetch
 * already retries a 5xx once), one more primary try on an empty or failed
 * reply, then one try on the fallback model when configured.
 */
export async function complete(
  config: DirectModelConfig,
  messages: ChatMessage[],
  options: CompleteOptions,
): Promise<Completion> {
  const backoffMs = options.backoffMs ?? 600;
  const send = resilientFetch(options.fetch ?? fetch, {
    attempts: 2,
    backoffMs,
    firstByteMs: options.firstByteMs ?? 60_000,
  });
  const log = options.log ?? ((line: string) => console.info(line));
  const plan = [config.model, config.model];
  if (config.fallbackModel && config.fallbackModel !== config.model)
    plan.push(config.fallbackModel);
  let reason = 'no reply';
  let emitted = false;
  const tracked: CompleteOptions = {
    ...options,
    onDelta: options.onDelta
      ? (text) => {
          emitted = true;
          options.onDelta!(text);
        }
      : undefined,
  };
  for (const [index, model] of plan.entries()) {
    options.signal.throwIfAborted();
    try {
      const text = await attempt(config, model, messages, tracked, send);
      if (text.trim()) {
        log(`[direct-model] reply from model=${model} attempt=${index + 1}`);
        return { text, model };
      }
      reason = 'empty reply';
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason ?? error;
      if (error instanceof DirectModelError) throw error;
      // Never replay after text reached the caller; that would duplicate it.
      if (emitted)
        throw new DirectModelError(
          'The reply was interrupted. Please try again.',
        );
      reason =
        error instanceof RetryableError ? error.message : 'connection failed';
    }
    log(
      `[direct-model] attempt ${index + 1} on model=${model} failed: ${reason}`,
    );
    if (index < plan.length - 1 && backoffMs)
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new DirectModelError(
    reason === 'empty reply'
      ? 'The model returned an empty reply. Please try again in a moment.'
      : 'The model is temporarily unavailable. Please try again in a moment.',
  );
}
