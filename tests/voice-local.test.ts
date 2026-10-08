import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { VoiceService } from '../src/server/voice.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
const resources: (() => void)[] = [];
afterEach(() => {
  resources.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
function fixture(provider: 'local' | 'openai' = 'local') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.bindThread('thread', workspace.dots()[0].id, 'A conversation');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceName: 'marin',
    runtimeUrl: '',
    slackUsers: [],
    localVoiceUrl: 'http://127.0.0.1:4320/',
    localVoiceSecret: 'x'.repeat(32),
  };
  const turn = vi.fn(
    async (_thread: string, _prompt: string, _signal: AbortSignal) =>
      '**Sure**, here is the answer. See https://example.com',
  );
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/stt')
      ? Response.json({ text: ' What time is it? ', language: 'en' })
      : new Response(new Uint8Array([82, 73, 70, 70]), {
          headers: { 'content-type': 'audio/wav' },
        }),
  );
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn,
      history: async () => '',
      requireReady() {},
      setup: () => ({
        voice: true,
        voiceProvider: provider,
        intelligence: true,
        model: true,
        browser: false,
        slack: 'not_configured',
        missing: [],
      }),
    },
    transport,
  );
  return { voice, transport, workspace, turn };
}
const audio = Buffer.from('RIFF....WAVE').toString('base64');
it('transcribes an utterance, answers through the Dot, and returns speakable text', async () => {
  const f = fixture();
  const call = f.voice.beginLocal('thread');
  f.voice.activate(call.id);
  const result = await f.voice.localTurn(call.id, audio);
  expect(result.userText).toBe('What time is it?');
  expect(result.replyText).not.toMatch(/[*]|https?:/);
  expect(result.replyText).toContain('here is the answer');
  const [url, init] = f.transport.mock.calls[0];
  expect(String(url)).toBe('http://127.0.0.1:4320/stt');
  expect((init?.headers as Record<string, string>)['X-Voice-Secret']).toBe(
    'x'.repeat(32),
  );
  expect(f.turn.mock.calls[0][1]).toContain('User said: What time is it?');
  const wav = await f.voice.speak(call.id, 'Hello there.');
  expect(new Uint8Array(wav).length).toBe(4);
  expect(String(f.transport.mock.calls[1][0])).toBe(
    'http://127.0.0.1:4320/tts',
  );
  await f.voice.end(call.id, 'You: hi');
});
it('skips the Dot when nothing intelligible was heard', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(Response.json({ text: '  ' }));
  const call = f.voice.beginLocal('thread');
  f.voice.activate(call.id);
  expect(await f.voice.localTurn(call.id, audio)).toEqual({
    userText: '',
    replyText: '',
  });
  expect(f.turn).not.toHaveBeenCalled();
  await f.voice.end(call.id, '');
});
it('refuses local calls when local voice is not the configured provider', () => {
  const f = fixture('openai');
  expect(() => f.voice.beginLocal('thread')).toThrow(/Local voice setup/);
});
it('allows only one call at a time and ends it cleanly', async () => {
  const f = fixture();
  const call = f.voice.beginLocal('thread');
  expect(() => f.voice.beginLocal('thread')).toThrow(/End the current call/);
  await f.voice.end(call.id, '');
  expect(() => f.voice.beginLocal('thread')).not.toThrow();
});
