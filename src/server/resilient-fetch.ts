// Model gateways that route across free providers fail in ways the OpenAI client
// does not retry: an overload arrives as HTTP 200 with {"error":{"code":503}} in
// the body, or as the first event of an SSE stream, and some routes hang before the
// first byte. This wraps fetch for chat requests, retrying those cases a few times
// before the run sees a failure.
const transient =
  /overloaded|temporarily|unavailable|rate.?limit|try again|\b(408|429|500|502|503|504|529)\b/i;

export interface ResilientFetchOptions {
  attempts?: number;
  /** How long a route may stay silent before the attempt is abandoned and retried. */
  firstByteMs?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function isTransientBody(text: string) {
  // Only error envelopes count; a normal completion that mentions "503" must pass.
  if (!/"error"\s*:/.test(text) || /"choices"\s*:\s*\[\s*\{/.test(text))
    return false;
  return transient.test(text);
}

export function resilientFetch(
  base: typeof fetch = fetch,
  options: ResilientFetchOptions = {},
): typeof fetch {
  const attempts = options.attempts ?? 3;
  const firstByteMs = options.firstByteMs ?? 60_000;
  const backoffMs = options.backoffMs ?? 600;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // Only chat/completions bodies are strings that can be replayed safely.
    if (!url.includes('/chat/completions') || typeof init?.body !== 'string')
      return base(input, init);
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts;
      const guard = new AbortController();
      const outer = init.signal;
      const forward = () => guard.abort(outer?.reason);
      if (outer?.aborted) forward();
      else outer?.addEventListener('abort', forward, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const retry = async () => {
        outer?.removeEventListener('abort', forward);
        if (outer?.aborted) throw outer.reason ?? new Error('Aborted');
        await sleep(backoffMs * attempt);
      };
      try {
        timer = last
          ? undefined
          : setTimeout(
              () => guard.abort(new Error('first byte timeout')),
              firstByteMs,
            );
        const response = await base(input, { ...init, signal: guard.signal });
        if (
          !last &&
          [408, 429, 500, 502, 503, 504, 529].includes(response.status)
        ) {
          clearTimeout(timer);
          await response.body?.cancel().catch(() => undefined);
          await retry();
          continue;
        }
        const type = response.headers.get('content-type') ?? '';
        if (type.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader();
          const first = await reader.read();
          clearTimeout(timer);
          const head = first.value ? new TextDecoder().decode(first.value) : '';
          if (!last && isTransientBody(head)) {
            await reader.cancel().catch(() => undefined);
            await retry();
            continue;
          }
          const replay = new ReadableStream<Uint8Array>({
            start(controller) {
              if (first.value) controller.enqueue(first.value);
              if (first.done) controller.close();
            },
            async pull(controller) {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            cancel: (reason) => reader.cancel(reason),
          });
          outer?.removeEventListener('abort', forward);
          return new Response(replay, response);
        }
        const text = await response.clone().text();
        clearTimeout(timer);
        if (!last && isTransientBody(text)) {
          await retry();
          continue;
        }
        outer?.removeEventListener('abort', forward);
        return response;
      } catch (error) {
        clearTimeout(timer);
        if (last || outer?.aborted) throw error;
        await retry();
      }
    }
  };
}
