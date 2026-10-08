# Local voice service

Speech for OpenDots calls without an outside provider: [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
transcribes what you say and [Piper](https://github.com/OHF-Voice/piper1-gpl) speaks the Dot's reply. Both run on this
machine (CPU). OpenDots uses it when `LOCAL_VOICE_URL` and `LOCAL_VOICE_SECRET` are set; otherwise it uses the
OpenAI Realtime provider if `VOICE_API_KEY` and `VOICE_MODEL` are set.

## Setup (Linux / WSL)

```sh
mkdir -p ~/opendots-voice && cd ~/opendots-voice
python3 -m venv .venv && . .venv/bin/activate
pip install faster-whisper piper-tts fastapi "uvicorn[standard]" python-multipart numpy
python -m piper.download_voices --download-dir voices en_US-lessac-medium
```

Create `~/opendots-voice/voice.env` (keep it private):

```dotenv
LOCAL_VOICE_SECRET=<random string, at least 24 characters>
WHISPER_MODEL=base
# Optional: reuse a Hugging Face cache that already holds Systran/faster-whisper-* models
# WHISPER_CACHE_DIR=/path/to/huggingface/hub
# Optional: pin the language instead of auto-detecting, for example en
# WHISPER_LANGUAGE=en
```

Run it (loopback only):

```sh
set -a; . ~/opendots-voice/voice.env; set +a
uvicorn server:app --app-dir /path/to/OpenDots/services/local-voice --host 127.0.0.1 --port 4320
```

Then add to the OpenDots `.env` and restart the app:

```dotenv
LOCAL_VOICE_URL=http://127.0.0.1:4320
LOCAL_VOICE_SECRET=<the same value>
```

## Notes

- Model choice trades accuracy for speed on CPU. `base` is the default: about 1.5 s to transcribe a 3-second
  utterance on 8 cores. `small` is more accurate but about 2.5x slower (3.9 s for the same clip), and `medium`
  is too slow for conversation without a GPU.
- Use headphones for calls. The browser applies echo cancellation, but speakers can still make the Dot hear itself.
- The service only accepts requests with the shared secret and should stay bound to `127.0.0.1`.
