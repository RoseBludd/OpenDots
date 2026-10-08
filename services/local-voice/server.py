"""Local speech service for OpenDots voice calls.

POST /stt   raw WAV bytes            -> {"text", "language", "duration"}  (faster-whisper)
POST /tts   {"text": "..."}          -> audio/wav                          (Piper)
GET  /health                         -> readiness, no secret needed

Everything runs on this machine. Requests must carry X-Voice-Secret, which is the
same value as LOCAL_VOICE_SECRET in the OpenDots .env. Bind to loopback only.
"""

import hmac
import io
import os
import threading
import wave

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request, Response
from faster_whisper import WhisperModel
from piper import PiperVoice

SECRET = os.environ.get("LOCAL_VOICE_SECRET", "")
if len(SECRET) < 24:
    raise SystemExit("LOCAL_VOICE_SECRET must contain at least 24 characters.")

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
WHISPER_CACHE = os.environ.get("WHISPER_CACHE_DIR") or None
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None  # None = auto-detect
WHISPER_THREADS = int(os.environ.get("WHISPER_THREADS", "6"))
PIPER_VOICE = os.environ.get(
    "PIPER_VOICE", os.path.expanduser("~/opendots-voice/voices/en_US-lessac-medium.onnx")
)
MAX_AUDIO_BYTES = 4_000_000
MAX_TEXT = 1500

app = FastAPI(title="opendots-local-voice", docs_url=None, redoc_url=None, openapi_url=None)
stt_model = WhisperModel(
    WHISPER_MODEL,
    device="cpu",
    compute_type="int8",
    cpu_threads=WHISPER_THREADS,
    download_root=WHISPER_CACHE,
)
tts_voice = PiperVoice.load(PIPER_VOICE)
# One inference at a time per engine keeps latency predictable on a CPU-only box.
stt_lock = threading.Lock()
tts_lock = threading.Lock()


def decode_wav(body: bytes) -> np.ndarray:
    """PCM WAV bytes -> mono float32 at 16 kHz (what Whisper expects)."""
    try:
        with wave.open(io.BytesIO(body), "rb") as wav:
            channels, width, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as error:
        raise HTTPException(status_code=415, detail=f"Expected PCM WAV audio: {error}")
    if width != 2:
        raise HTTPException(status_code=415, detail="Expected 16-bit PCM WAV audio.")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples[: len(samples) - len(samples) % channels].reshape(-1, channels).mean(axis=1)
    if rate != 16_000 and len(samples):
        target = int(len(samples) * 16_000 / rate)
        samples = np.interp(
            np.linspace(0, len(samples) - 1, num=target), np.arange(len(samples)), samples
        ).astype(np.float32)
    return samples


def check(secret: str | None) -> None:
    if not secret or not hmac.compare_digest(secret, SECRET):
        raise HTTPException(status_code=401, detail="Invalid voice secret.")


@app.get("/health")
def health():
    return {"ok": True, "whisper": WHISPER_MODEL, "voice": os.path.basename(PIPER_VOICE)}


@app.post("/stt")
async def stt(request: Request, x_voice_secret: str | None = Header(default=None)):
    check(x_voice_secret)
    body = await request.body()
    if not body or len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio is empty or too large.")
    audio = decode_wav(body)
    with stt_lock:
        segments, info = stt_model.transcribe(
            audio,
            language=WHISPER_LANGUAGE,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return {"text": text, "language": info.language, "duration": round(info.duration, 2)}


@app.post("/tts")
async def tts(request: Request, x_voice_secret: str | None = Header(default=None)):
    check(x_voice_secret)
    data = await request.json()
    text = str(data.get("text", "")).strip()
    if not text or len(text) > MAX_TEXT:
        raise HTTPException(status_code=400, detail="Text is empty or too long.")
    out = io.BytesIO()
    with tts_lock, wave.open(out, "wb") as wav:
        tts_voice.synthesize_wav(text, wav)
    return Response(content=out.getvalue(), media_type="audio/wav")
