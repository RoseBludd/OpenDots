import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from './api';
import { splitSentences } from '../shared/voice-text';

// Local voice call: the browser listens for utterances, the server transcribes
// them (Whisper), the Dot answers, and a local voice (Piper) speaks the reply.
// Returns the same shape as useVoice so CallView works with either.

const FRAME_SAMPLES_MS = 30;
const PREROLL_FRAMES = 10; // ~300 ms kept so the first syllable is not clipped
const END_SILENCE_MS = 900;
const MIN_VOICED_MS = 350;
const MAX_UTTERANCE_MS = 20_000;
const MIN_THRESHOLD = 0.006;
const SPEAKING_THRESHOLD_FACTOR = 2.4; // harder to trigger while the Dot talks
const TARGET_RATE = 16_000;
const SILENT_MIC_MS = 6000; // warn if the chosen microphone stays this quiet
const SILENT_LEVEL = 0.002;
const DEVICE_KEY = 'opendots.micDeviceId';

export interface LocalVoiceExtras {
  level: number;
  devices: { id: string; label: string }[];
  deviceId: string;
  micHint: string;
  selectDevice: (id: string) => Promise<void>;
}

function savedDevice() {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveDevice(id: string) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

function openMic(deviceId: string) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

const WORKLET = `class PCM extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('pcm-capture', PCM);`;

function rmsOf(frame: Float32Array) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

function toWavBase64(frames: Float32Array[], sampleRate: number) {
  let length = 0;
  for (const frame of frames) length += frame.length;
  const ratio = sampleRate / TARGET_RATE;
  const outLength = Math.floor(length / ratio);
  const flat = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    flat.set(frame, offset);
    offset += frame.length;
  }
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += flat[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function useLocalVoice(
  threadId: string,
  onSaved: () => void,
  anchorMessageId?: string,
) {
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'active' | 'ending'
  >('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<'listening' | 'speaking' | 'thinking'>(
    'listening',
  );
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState(savedDevice);
  const [micHint, setMicHint] = useState('');
  const mutedRef = useRef(false);
  const generation = useRef(0);
  const connecting = useRef(false);
  const ending = useRef(false);
  const anchor = useRef(anchorMessageId);
  anchor.current = anchorMessageId;
  const session = useRef<
    | {
        id?: string;
        stream: MediaStream;
        source: MediaStreamAudioSourceNode;
        context: AudioContext;
        node: AudioWorkletNode;
        peak: number;
        transcript: string[];
        timer?: ReturnType<typeof setTimeout>;
        cancelled: boolean;
        speakerMuted: boolean;
        speakGeneration: number;
        playing?: HTMLAudioElement;
        busy: boolean;
        queue: string[];
      }
    | undefined
  >(undefined);

  const stopPlayback = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.speakGeneration++;
    if (current.playing) {
      current.playing.pause();
      current.playing.src = '';
      current.playing = undefined;
    }
  }, []);

  const closeMedia = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    stopPlayback();
    current.node.port.onmessage = null;
    current.node.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => {});
    clearTimeout(current.timer);
  }, [stopPlayback]);

  const end = useCallback(async () => {
    if (ending.current) return;
    generation.current++;
    connecting.current = false;
    const current = session.current;
    if (!current) {
      setStatus('idle');
      return;
    }
    current.cancelled = true;
    stopPlayback();
    current.stream.getTracks().forEach((track) => {
      track.enabled = false;
    });
    clearTimeout(current.timer);
    ending.current = true;
    setStatus('ending');
    try {
      if (current.id)
        await api(`/voice/calls/${current.id}/end`, 'POST', {
          transcript: current.transcript.join('\n').slice(0, 20000),
          anchorMessageId: anchor.current,
        });
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Call ended, but its receipt could not be saved.',
      );
    } finally {
      closeMedia();
      session.current = undefined;
      ending.current = false;
      setStatus('idle');
    }
  }, [closeMedia, onSaved, stopPlayback]);

  useEffect(
    () => () => {
      generation.current++;
      const current = session.current;
      closeMedia();
      if (current?.id && !ending.current)
        void fetch(`/api/voice/calls/${current.id}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            transcript: current.transcript.join('\n').slice(0, 20000),
            anchorMessageId: anchor.current,
          }),
          keepalive: true,
        }).catch(() => {});
    },
    [closeMedia],
  );

  // Notice calls the server ended (paused workspace, expiry, limits).
  useEffect(() => {
    if (status !== 'active' && status !== 'connecting') return;
    const timer = setInterval(() => {
      const current = session.current;
      const id = current?.id;
      if (id)
        void api<{ endedAt: number | null }>(`/voice/calls/${id}`)
          .then((call) => {
            if (session.current === current && call.endedAt) void end();
          })
          .catch(() => {
            if (session.current !== current) return;
            setError('Call control connection was lost.');
            void end();
          });
    }, 2000);
    return () => clearInterval(timer);
  }, [status, end]);

  const speak = useCallback(
    async (current: NonNullable<typeof session.current>, text: string) => {
      const sentences = splitSentences(text);
      if (!sentences.length) return;
      const generationAtStart = ++current.speakGeneration;
      const fetchAudio = async (sentence: string) => {
        const response = await fetch(`/api/voice/calls/${current.id}/speak`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ text: sentence }),
        });
        if (!response.ok)
          throw new Error(`Speech synthesis failed (${response.status}).`);
        return URL.createObjectURL(await response.blob());
      };
      // Synthesize one sentence ahead so playback has no gaps.
      const fetched = new Map<number, Promise<string>>();
      const prefetch = (index: number) => {
        const text = sentences[index];
        if (text === undefined) return undefined;
        let pending = fetched.get(index);
        if (!pending) {
          pending = fetchAudio(text);
          fetched.set(index, pending);
        }
        return pending;
      };
      const discardPrefetched = () => {
        for (const pending of fetched.values())
          void pending.then((u) => URL.revokeObjectURL(u)).catch(() => {});
        fetched.clear();
      };
      setCaption('');
      for (let i = 0; i < sentences.length; i++) {
        const url = await prefetch(i);
        fetched.delete(i);
        void prefetch(i + 1)?.catch(() => {});
        const sentence = sentences[i] ?? '';
        if (
          !url ||
          current.cancelled ||
          current.speakGeneration !== generationAtStart
        ) {
          if (url) URL.revokeObjectURL(url);
          discardPrefetched();
          return;
        }
        setPhase('speaking');
        setCaption((value) => (value ? `${value} ${sentence}` : sentence));
        const audio = new Audio(url);
        audio.muted = current.speakerMuted;
        current.playing = audio;
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio.onpause = () => resolve();
          void audio.play().catch(() => resolve());
        });
        URL.revokeObjectURL(url);
        if (current.speakGeneration !== generationAtStart) {
          discardPrefetched();
          return;
        }
      }
      current.playing = undefined;
    },
    [],
  );

  const handleUtterance = useCallback(
    async (current: NonNullable<typeof session.current>, wav: string) => {
      if (current.busy) {
        current.queue.push(wav);
        return;
      }
      current.busy = true;
      try {
        let next: string | undefined = wav;
        while (next && !current.cancelled) {
          setPhase('thinking');
          const result = await api<{ userText: string; replyText: string }>(
            `/voice/calls/${current.id}/turn`,
            'POST',
            { audio: next },
          );
          if (current.cancelled) return;
          if (result.userText) {
            current.transcript.push(`You: ${result.userText}`);
            setUserCaption(result.userText);
          }
          if (result.replyText) {
            current.transcript.push(`Dot: ${result.replyText}`);
            await speak(current, result.replyText);
          }
          next = current.queue.shift();
        }
        if (!current.cancelled) setPhase('listening');
      } catch (e) {
        if (!current.cancelled) {
          setError(e instanceof Error ? e.message : 'The voice turn failed.');
          setPhase('listening');
        }
      } finally {
        current.busy = false;
      }
    },
    [speak],
  );

  // Labels are only available once microphone permission has been granted.
  const refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((device) => device.kind === 'audioinput')
          .map((device, index) => ({
            id: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          })),
      );
    } catch {
      setDevices([]);
    }
  };

  // Switch microphones without ending the call.
  const selectDevice = async (id: string) => {
    saveDevice(id);
    setDeviceId(id);
    const current = session.current;
    if (!current || current.cancelled) return;
    try {
      const next = await openMic(id);
      if (session.current !== current || current.cancelled) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      next.getAudioTracks().forEach((track) => {
        track.enabled = !mutedRef.current;
      });
      current.source.disconnect();
      current.stream.getTracks().forEach((track) => track.stop());
      current.source = current.context.createMediaStreamSource(next);
      current.source.connect(current.node);
      current.stream = next;
      current.peak = 0;
      setMicHint('');
      void refreshDevices();
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not switch microphone: ${e.message}`
          : 'Could not switch microphone.',
      );
    }
  };

  const start = async () => {
    if (session.current || connecting.current || ending.current) return;
    connecting.current = true;
    const attempt = ++generation.current;
    setStatus('connecting');
    setError('');
    mutedRef.current = false;
    setMuted(false);
    setSpeakerMuted(false);
    setStartedAt(undefined);
    setPhase('listening');
    setCaption('');
    setUserCaption('');
    setLevel(0);
    setMicHint('');
    let stream: MediaStream | undefined;
    try {
      try {
        stream = await openMic(deviceId);
      } catch (e) {
        // A remembered microphone that was unplugged: fall back to the default.
        if (!deviceId || !(e instanceof DOMException)) throw e;
        if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')
          throw e;
        saveDevice('');
        setDeviceId('');
        stream = await openMic('');
      }
      void refreshDevices();
      if (attempt !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      await context.resume();
      const moduleUrl = URL.createObjectURL(
        new Blob([WORKLET], { type: 'application/javascript' }),
      );
      await context.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      const node = new AudioWorkletNode(context, 'pcm-capture');
      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      const current = {
        id: undefined as string | undefined,
        stream,
        source,
        context,
        node,
        peak: 0,
        transcript: [] as string[],
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        cancelled: false,
        speakerMuted: false,
        speakGeneration: 0,
        playing: undefined as HTMLAudioElement | undefined,
        busy: false,
        queue: [] as string[],
      };
      session.current = current;

      // Voice activity detection on ~30 ms frames.
      const frameSize = Math.round(
        (context.sampleRate * FRAME_SAMPLES_MS) / 1000,
      );
      let pending = new Float32Array(0);
      let noiseFloor = 0.004;
      let state: 'idle' | 'speech' = 'idle';
      let preroll: Float32Array[] = [];
      let utterance: Float32Array[] = [];
      let voicedMs = 0;
      let utteranceMs = 0;
      let silenceMs = 0;
      let hot = 0;
      let meterFrames = 0;
      let meterPeak = 0;
      const finish = () => {
        const frames = utterance;
        const voiced = voicedMs;
        state = 'idle';
        utterance = [];
        preroll = [];
        voicedMs = utteranceMs = silenceMs = hot = 0;
        if (voiced < MIN_VOICED_MS || !current.id) return;
        void handleUtterance(current, toWavBase64(frames, context.sampleRate));
      };
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (current.cancelled || !current.id) return;
        const chunk = event.data;
        const merged = new Float32Array(pending.length + chunk.length);
        merged.set(pending);
        merged.set(chunk, pending.length);
        pending = merged;
        while (pending.length >= frameSize) {
          const frame = pending.slice(0, frameSize);
          pending = pending.slice(frameSize);
          const level = rmsOf(frame);
          current.peak = Math.max(current.peak, level);
          meterPeak = Math.max(meterPeak, level);
          if (level > 0.01) setMicHint((hint) => (hint ? '' : hint));
          if (++meterFrames >= 3) {
            setLevel(Math.min(1, Math.sqrt(meterPeak) * 2.2));
            meterFrames = 0;
            meterPeak = 0;
          }
          const speaking = !!current.playing;
          const threshold =
            Math.max(MIN_THRESHOLD, noiseFloor * 3.5) *
            (speaking ? SPEAKING_THRESHOLD_FACTOR : 1);
          const loud = level > threshold;
          if (state === 'idle') {
            if (!loud) noiseFloor = noiseFloor * 0.95 + level * 0.05;
            preroll.push(frame);
            if (preroll.length > PREROLL_FRAMES) preroll.shift();
            hot = loud ? hot + 1 : 0;
            if (hot >= 2) {
              state = 'speech';
              utterance = [...preroll];
              voicedMs = hot * FRAME_SAMPLES_MS;
              utteranceMs = utterance.length * FRAME_SAMPLES_MS;
              silenceMs = 0;
              // Talking over the Dot interrupts it.
              if (current.playing) stopPlayback();
              setUserCaption('');
            }
          } else {
            utterance.push(frame);
            utteranceMs += FRAME_SAMPLES_MS;
            if (loud) {
              voicedMs += FRAME_SAMPLES_MS;
              silenceMs = 0;
            } else silenceMs += FRAME_SAMPLES_MS;
            if (silenceMs >= END_SILENCE_MS || utteranceMs >= MAX_UTTERANCE_MS)
              finish();
          }
        }
      };

      const response = await api<{ id: string }>('/voice/local/calls', 'POST', {
        threadId,
      });
      current.id = response.id;
      if (current.cancelled) {
        await api(`/voice/calls/${response.id}/end`, 'POST', {
          transcript: '',
        });
        return;
      }
      await api(`/voice/calls/${response.id}/active`, 'POST', {});
      setStatus('active');
      setStartedAt(Date.now());
      current.timer = setTimeout(() => void end(), 15 * 60_000);
      // If the chosen microphone stays silent, say so instead of waiting forever.
      setTimeout(() => {
        if (session.current !== current || current.cancelled) return;
        if (current.peak < SILENT_LEVEL && !mutedRef.current)
          setMicHint(
            `No sound from "${current.stream.getAudioTracks()[0]?.label || 'the microphone'}". Pick another microphone below, or check Windows sound input settings.`,
          );
      }, SILENT_MIC_MS);
    } catch (e) {
      if (attempt !== generation.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      const current = session.current;
      const id = current?.id;
      if (id)
        void api(`/voice/calls/${id}/end`, 'POST', {
          transcript: '',
          anchorMessageId: anchor.current,
        }).catch(() => {});
      stream?.getTracks().forEach((track) => track.stop());
      closeMedia();
      session.current = undefined;
      setStatus('idle');
      setError(e instanceof Error ? e.message : 'Could not start the call.');
    } finally {
      if (attempt === generation.current) connecting.current = false;
    }
  };

  const toggleMute = () => {
    const next = !muted;
    session.current?.stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    mutedRef.current = next;
    setMuted(next);
  };
  const toggleSpeaker = () => {
    const next = !speakerMuted;
    const current = session.current;
    if (current) {
      current.speakerMuted = next;
      if (current.playing) current.playing.muted = next;
    }
    setSpeakerMuted(next);
  };
  return {
    status,
    error,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    phase,
    caption,
    userCaption,
    toggleMute,
    toggleSpeaker,
    level,
    devices,
    deviceId,
    micHint,
    selectDevice,
  };
}
