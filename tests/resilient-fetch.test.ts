import { expect, it } from 'vitest';
import { resilientFetch } from '../src/server/resilient-fetch.js';

const url = 'https://gateway.test/v1/chat/completions';
const body = JSON.stringify({ model: 'm', messages: [] });
const ok = { choices: [{ message: { content: 'done' } }] };
const overload = {
  error: {
    message: 'Upstream error from Nvidia: Service temporarily overloaded',
    code: 503,
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const sse = (...events: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
function scripted(...responses: Array<() => Response | Promise<Response>>) {
  let calls = 0;
  const fetcher = (async () =>
    responses[Math.min(calls++, responses.length - 1)]()) as typeof fetch;
  return { fetcher, calls: () => calls };
}
const options = { sleep: async () => undefined, backoffMs: 0 };

it('retries an overload that arrives as HTTP 200 with an error body', async () => {
  const s = scripted(
    () => json(overload),
    () => json(overload),
    () => json(ok),
  );
  const response = await resilientFetch(s.fetcher, options)(url, {
    method: 'POST',
    body,
  });
  expect(await response.json()).toEqual(ok);
  expect(s.calls()).toBe(3);
});

it('retries a streamed overload and replays the successful stream intact', async () => {
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
  const s = scripted(
    () => sse(`data: ${JSON.stringify(overload)}\n\n`),
    () => sse(event, 'data: [DONE]\n\n'),
  );
  const response = await resilientFetch(s.fetcher, options)(url, {
    method: 'POST',
    body,
  });
  expect(await response.text()).toBe(event + 'data: [DONE]\n\n');
  expect(s.calls()).toBe(2);
});

it('retries retryable statuses and network errors, then returns the last answer', async () => {
  const s = scripted(
    () => json({ error: 'busy' }, 503),
    () => {
      throw new TypeError('fetch failed');
    },
    () => json({ error: 'busy' }, 503),
  );
  const response = await resilientFetch(s.fetcher, options)(url, {
    method: 'POST',
    body,
  });
  expect(response.status).toBe(503);
  expect(s.calls()).toBe(3);
});

it('does not retry real answers, other errors, or other endpoints', async () => {
  const mentions = {
    choices: [{ message: { content: 'error code 503 explained' } }],
  };
  const a = scripted(() => json(mentions));
  expect(
    await (
      await resilientFetch(a.fetcher, options)(url, { method: 'POST', body })
    ).json(),
  ).toEqual(mentions);
  expect(a.calls()).toBe(1);
  const b = scripted(() =>
    json({ error: { message: 'invalid api key', code: 401 } }, 401),
  );
  expect(
    (await resilientFetch(b.fetcher, options)(url, { method: 'POST', body }))
      .status,
  ).toBe(401);
  expect(b.calls()).toBe(1);
  const c = scripted(() => json(overload));
  await resilientFetch(c.fetcher, options)('https://gateway.test/v1/models', {
    method: 'GET',
  });
  expect(c.calls()).toBe(1);
});

it('stops retrying when the caller aborts', async () => {
  const controller = new AbortController();
  const s = scripted(() => {
    controller.abort(new Error('stopped'));
    return json(overload);
  });
  await expect(
    resilientFetch(s.fetcher, options)(url, {
      method: 'POST',
      body,
      signal: controller.signal,
    }),
  ).rejects.toThrow('stopped');
  expect(s.calls()).toBe(1);
});
