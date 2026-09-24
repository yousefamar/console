"""Synthesise the harness prompts (16 kHz mono s16) with the configured
Cartesia voice: q1 = greeting reply, q2 = a calendar question (tool path),
q3 = the hang-up request."""

from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from al_voice.config import Config  # noqa: E402

PROMPTS = {
    "q1": "Hello, yes, I can hear you fine.",
    "q2": "What is on my calendar tomorrow?",
    "q3": "Okay, thanks. Hang up.",
    "q4": "Tell me a long story.",
    "q5": "Can you say something in Arabic?",
    # Continuous talking-over with no pause the STT could endpoint on
    # (the 24 Sept call: seven "hello"s over a sentence, no cut-off).
    "q6": "hello hello hello hello hello hello hello hello hello",
}


def main() -> None:
    cfg = Config.load()
    here = Path(__file__).parent
    for name, text in PROMPTS.items():
        r = httpx.post(
            "https://api.cartesia.ai/tts/bytes",
            headers={"X-API-Key": cfg.cartesia_api_key, "Cartesia-Version": "2025-04-16"},
            json={"model_id": cfg.cartesia_tts_model, "transcript": text, "voice": {"mode": "id", "id": cfg.cartesia_voice_id},
                  "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 16000}, "language": "en"},
            timeout=30,
        )
        r.raise_for_status()
        (here / f"{name}.wav").write_bytes(r.content)
        print(name, len(r.content), text)


if __name__ == "__main__":
    main()
