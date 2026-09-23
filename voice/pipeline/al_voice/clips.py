"""Pre-rendered lines in Yousef's clone for when the live pipeline cannot speak.

Call 008048b0 (2026-09-23): Pipecat timed out setting the pipeline up after
Yousef had picked up, and he listened to 33 s of comfort noise. Anything said
at that point cannot depend on Cartesia being reachable, so the apology and
the hold-on line are rendered once (Cartesia REST, 16 kHz s16le mono — the
slot's own format) into `~/.config/console/voice-clips/` and played straight
to the sidecar slot, no pipeline involved."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import httpx
from loguru import logger

from .config import Config

CARTESIA_VERSION = "2026-08-14"

# Per language; anything else falls back to English. The apology promises a
# text because AL's parent gets the failure envelope and sends one.
CLIP_TEXTS: dict[str, dict[str, str]] = {
    "apology": {
        "en": "Sorry, I have a technical problem on my side. I'll text you instead.",
        "ar": "معلش، عندي مشكلة تقنية عندي. هبعتلك رسالة بدل المكالمة.",
        "de": "Entschuldige, ich habe gerade ein technisches Problem. Ich schreibe dir stattdessen.",
        "fr": "Désolé, j'ai un problème technique de mon côté. Je t'envoie un message à la place.",
        "it": "Scusa, ho un problema tecnico da parte mia. Ti scrivo un messaggio invece.",
        "es": "Perdona, tengo un problema técnico por mi parte. Te escribo un mensaje en su lugar.",
    },
    "hold_on": {
        "en": "One moment, I'm just connecting.",
        "ar": "لحظة واحدة، بوصّل الخط.",
        "de": "Einen Moment, ich verbinde gerade.",
        "fr": "Un instant, je me connecte.",
        "it": "Un momento, mi sto collegando.",
        "es": "Un momento, me estoy conectando.",
    },
}


def clip_text(name: str, language: str | None) -> tuple[str, str]:
    """(language actually used, text)."""
    texts = CLIP_TEXTS[name]
    lang = (language or "en").split("-")[0].lower()
    if lang in texts:
        return lang, texts[lang]
    return "en", texts["en"]


class ClipStore:
    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._dir: Path = cfg.clips_dir
        self._mem: dict[str, bytes] = {}
        self.missing: list[str] = []

    def _path(self, name: str, lang: str, text: str) -> Path:
        key = hashlib.sha256(f"{self._cfg.cartesia_voice_id}|{self._cfg.cartesia_tts_model}|{text}".encode()).hexdigest()[:10]
        return self._dir / f"{name}.{lang}.{key}.pcm"

    def get(self, name: str, language: str | None) -> tuple[str, bytes] | None:
        """(text, 16 kHz s16le PCM) from memory or disk; None when it was never
        rendered — never blocks on the network."""
        lang, text = clip_text(name, language)
        path = self._path(name, lang, text)
        pcm = self._mem.get(str(path))
        if pcm is None:
            try:
                pcm = path.read_bytes()
            except OSError:
                if lang != "en":
                    return self.get(name, "en")
                return None
            self._mem[str(path)] = pcm
        return text, pcm

    async def ensure(self, languages: tuple[str, ...]) -> None:
        """Render every clip that is not on disk yet. Safe to call at every
        boot: a rendered clip is a file, so this is a no-op afterwards."""
        if not self._cfg.cartesia_api_key or not self._cfg.cartesia_voice_id:
            self.missing = [f"{n}.{lang}" for n in CLIP_TEXTS for lang in dict.fromkeys(("en", *languages))]
            logger.warning("voice clips: Cartesia not configured — no apology/hold-on clips")
            return
        self._dir.mkdir(parents=True, exist_ok=True)
        # English first: it is the fallback for every other language.
        wanted = [(name, lang) for lang in dict.fromkeys(("en", *languages)) for name in CLIP_TEXTS if lang in CLIP_TEXTS[name]]
        rendered = 0
        missing: list[str] = []
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0)) as http:
            for name, lang in wanted:
                _, text = clip_text(name, lang)
                path = self._path(name, lang, text)
                if path.exists():
                    continue
                try:
                    pcm = await self._render(http, text, lang)
                except Exception as e:  # noqa: BLE001
                    missing.append(f"{name}.{lang}")
                    logger.warning(f"voice clips: could not render {name}.{lang}: {e!r}")
                    continue
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(pcm)
                tmp.replace(path)
                self._mem[str(path)] = pcm
                rendered += 1
        self.missing = missing
        ready = len(wanted) - len(missing)
        msg = f"voice clips: {ready}/{len(wanted)} ready ({rendered} rendered now) in {self._dir}"
        if missing:
            logger.warning(f"{msg}; MISSING: {', '.join(missing)}")
        else:
            logger.info(msg)

    async def _render(self, http: httpx.AsyncClient, text: str, lang: str) -> bytes:
        cfg = self._cfg
        for attempt in range(4):
            r = await http.post(
                "https://api.cartesia.ai/tts/bytes",
                headers={"X-API-Key": cfg.cartesia_api_key, "Cartesia-Version": CARTESIA_VERSION},
                json={
                    "model_id": cfg.cartesia_tts_model,
                    "transcript": text,
                    "voice": {"mode": "id", "id": cfg.cartesia_voice_id},
                    "language": lang,
                    "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 16000},
                },
            )
            if r.status_code == 200 and len(r.content) > 3200:
                return r.content
            if r.status_code != 429 and r.status_code < 500:
                raise RuntimeError(f"cartesia {r.status_code}: {r.text[:200]}")
            await asyncio.sleep(0.8 * 2**attempt)
        raise RuntimeError(f"cartesia kept failing ({r.status_code})")

    def has(self, name: str, lang: str) -> bool:
        text = CLIP_TEXTS[name].get(lang)
        return text is not None and self._path(name, lang, text).exists()

    def status(self, languages: tuple[str, ...]) -> dict[str, object]:
        langs = dict.fromkeys(("en", *languages))
        ready = [f"{n}.{lang}" for n in CLIP_TEXTS for lang in langs if self.has(n, lang)]
        return {"dir": str(self._dir), "ready": ready, "missing": list(self.missing)}
