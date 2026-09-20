"""Per-sentence TTS language routing.

Cartesia phonemises and normalises a request in the `language` it is given, and
pipecat sends `en` on every request unless told otherwise — which is why the
first live call spoke Arabic and German "with a strong English accent". The
clone itself is single-language too (instant clones are built from one
recording); the `ar`/`de` accents were added to it with Cartesia's Add Voice
Accents API on 2026-09-20, so with the right `language` per sentence the same
voice_id now speaks them natively. Languages the voice has no accent for still
get correct normalisation and fall back to its native (British English) accent.

The router sits between the LLM and the TTS: it re-chunks the token stream into
sentences (pipecat's own aggregator, so nothing the TTS would have waited for is
delayed — the TTS itself runs in TOKEN mode and forwards each sentence as it
arrives), detects each sentence's language and, when it changes, pushes a
`TTSUpdateSettingsFrame(language=…)` ahead of the text AND an
`STTUpdateSettingsFrame(language=…)` upstream: Cartesia's STT has NO language
auto-detection (`language` "defaults to en" — the fifth call transcribed
Yousef's Arabic as English gibberish), and the caller almost always answers
in the language AL just spoke, so the STT follows the conversation. Detection
is script-first (Arabic/Hebrew/Cyrillic/CJK are unambiguous) and py3langid
over a broad Latin-script set (the voice's accents plus `VOICE_EXTRA_LANGUAGES`,
default it/fr/es/pt/nl/tr — Italian got English phonemes when the set was
en/de only) for Latin script; the previous language is kept unless the
classifier is confident, so a bare "Ja." mid-German does not flip to English."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Iterable

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    STTUpdateSettingsFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.cartesia.stt import CartesiaSTTService
from pipecat.services.cartesia.tts import CartesiaTTSSettings
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

DEFAULT_LANGUAGES = ("en", "ar", "de")
# Latin-script languages the classifier may pick even when the voice has no
# native accent for them: the `language` still fixes phonemes/normalisation.
EXTRA_LANGUAGES = ("it", "fr", "es", "pt", "nl", "tr")
CONFIDENCE = 0.85
MIN_LATIN_LETTERS = 4

# Scripts that identify a language on their own (Cartesia base codes).
_SCRIPT_LANG = {
    "ARABIC": "ar",
    "HEBREW": "he",
    "CYRILLIC": "ru",
    "GREEK": "el",
    "DEVANAGARI": "hi",
    "HANGUL": "ko",
    "HIRAGANA": "ja",
    "KATAKANA": "ja",
    "CJK": "zh",
    "THAI": "th",
    "GEORGIAN": "ka",
    "BENGALI": "bn",
    "TAMIL": "ta",
    "TELUGU": "te",
    "GUJARATI": "gu",
    "KANNADA": "kn",
    "MALAYALAM": "ml",
}

# What the pipeline says while a tool runs, in the language of the conversation.
FILLERS: dict[str, list[str]] = {
    "en": ["One sec.", "Let me check.", "Hang on a moment.", "Give me a second."],
    "ar": ["ثانية واحدة.", "خليني أشوف.", "لحظة.", "ثواني."],
    "de": ["Einen Moment.", "Ich schaue kurz nach.", "Sekunde.", "Moment bitte."],
    "it": ["Un attimo.", "Controllo subito.", "Un secondo."],
    "fr": ["Un instant.", "Je regarde.", "Une seconde."],
    "es": ["Un momento.", "Déjame ver.", "Un segundo."],
}

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def _script_of(ch: str) -> str | None:
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return None
    if name.startswith("CJK UNIFIED"):
        return "CJK"
    return name.split(" ", 1)[0]


class LanguageDetector:
    """Stateless language guess for one sentence; the router adds stickiness."""

    def __init__(self, candidates: Iterable[str] = DEFAULT_LANGUAGES):
        self.candidates = tuple(dict.fromkeys(c.lower().split("-")[0] for c in candidates if c)) or DEFAULT_LANGUAGES
        latin = [c for c in self.candidates if c not in _SCRIPT_LANG.values()]
        self._latin = tuple(latin) if latin else ("en",)
        self._ident = None
        if len(self._latin) > 1:
            try:
                from py3langid.langid import MODEL_DIR, MODEL_FILE, LanguageIdentifier

                self._ident = LanguageIdentifier.from_modelpath(Path(MODEL_DIR) / MODEL_FILE, norm_probs=True)
                self._ident.set_languages(list(self._latin))
            except Exception as e:  # noqa: BLE001
                logger.warning(f"language detector unavailable ({e!r}); Latin-script text stays {self._latin[0]}")

    def detect(self, text: str, previous: str) -> str:
        letters = [ch for ch in text if ch.isalpha()]
        if not letters:
            return previous
        scripts: dict[str, int] = {}
        for ch in letters:
            s = _script_of(ch)
            if s:
                scripts[s] = scripts.get(s, 0) + 1
        top_script, top_n = max(scripts.items(), key=lambda kv: kv[1]) if scripts else ("LATIN", len(letters))
        if top_script in _SCRIPT_LANG and top_n * 2 >= len(letters):
            return _SCRIPT_LANG[top_script]
        if top_script != "LATIN":
            return previous
        if len(letters) < MIN_LATIN_LETTERS:
            return previous if previous in self._latin else self._latin[0]
        if self._ident is None:
            return self._latin[0]
        lang, prob = self._ident.classify(text)
        if lang == previous or prob >= CONFIDENCE:
            return str(lang)
        return previous if previous in self._latin else self._latin[0]


class LanguageRouter(FrameProcessor):
    def __init__(self, candidates: Iterable[str] = DEFAULT_LANGUAGES, initial: str = "en", steer_stt: bool = True):
        super().__init__()
        self.detector = LanguageDetector(candidates)
        self.language = initial if initial in self.detector.candidates else self.detector.candidates[0]
        self._agg = SimpleTextAggregator()
        self.switches = 0
        self.steer_stt = steer_stt

    def filler(self) -> str:
        import random

        return random.choice(FILLERS.get(self.language) or FILLERS["en"])

    async def _emit(self, text: str, direction: FrameDirection) -> None:
        if not text.strip():
            return
        lang = self.detector.detect(text, self.language)
        if lang != self.language:
            logger.info(f"language {self.language} → {lang}: {text[:60]!r}")
            self.language = lang
            self.switches += 1
            await self.push_frame(TTSUpdateSettingsFrame(delta=CartesiaTTSSettings(language=lang)), direction)
            if self.steer_stt:
                # Upstream to the STT: Cartesia reconnects with the new language
                # (a ~1 s gap that lands while AL is still speaking).
                await self.push_frame(STTUpdateSettingsFrame(delta=CartesiaSTTService.Settings(language=lang)), FrameDirection.UPSTREAM)
        # Whole sentences, own spacing: the TTS forwards them verbatim (TOKEN
        # mode) and the transcript joins them without inventing spaces.
        frame = LLMTextFrame(text.strip() + " ")
        frame.includes_inter_frame_spaces = True
        await self.push_frame(frame, direction)

    async def _flush(self, direction: FrameDirection) -> None:
        rest = await self._agg.flush()
        if rest and rest.text:
            await self._emit(rest.text, direction)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame):
            async for sentence in self._agg.aggregate(frame.text):
                await self._emit(sentence.text, direction)
            return
        if isinstance(frame, LLMFullResponseEndFrame):
            await self._flush(direction)
        elif isinstance(frame, LLMFullResponseStartFrame):
            await self._agg.reset()
        elif isinstance(frame, InterruptionFrame):
            await self._agg.handle_interruption()
        elif isinstance(frame, (EndFrame, CancelFrame)):
            await self._agg.reset()
        await self.push_frame(frame, direction)


async def voice_languages(cfg) -> tuple[str, ...] | None:
    """The languages the configured Cartesia voice speaks natively, from its
    `accents` (base codes, native first). None when the lookup fails, so the
    configured default stays."""
    import httpx

    if not cfg.cartesia_api_key or not cfg.cartesia_voice_id:
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            r = await http.get(
                f"https://api.cartesia.ai/voices/{cfg.cartesia_voice_id}",
                headers={"X-API-Key": cfg.cartesia_api_key, "Cartesia-Version": "2026-08-14"},
            )
            r.raise_for_status()
            voice = r.json()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"voice accents lookup failed ({e!r}); tts languages stay {cfg.tts_languages}")
        return None
    accents = voice.get("accents") or []
    langs: list[str] = []
    for a in sorted(accents, key=lambda a: not a.get("is_native")):
        code = str(a.get("locale") or "").split("-")[0].lower()
        if code and code not in langs:
            langs.append(code)
    if not langs:
        base = str(voice.get("language") or "en").lower()
        logger.warning(f"voice {cfg.cartesia_voice_id} has no accents — only {base} will sound native (see Add Voice Accents)")
        return (base,)
    return tuple(langs)
