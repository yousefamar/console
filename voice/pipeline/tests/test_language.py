import pytest
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    STTUpdateSettingsFrame,
    TTSUpdateSettingsFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from al_voice.language import FILLERS, LanguageDetector, LanguageRouter, SegmentEndFrame


@pytest.fixture(scope="module")
def det() -> LanguageDetector:
    return LanguageDetector(("en", "ar", "de"))


@pytest.mark.parametrize(
    "text,prev,want",
    [
        ("تمام، أنا بتكلم معاك بالعربي المصري دلوقتي.", "en", "ar"),
        ("Ich bin Al. Das ist ein Test auf Deutsch.", "en", "de"),
        ("Okay, kein Problem, ich schaue nach.", "en", "de"),
        ("Right, so you're catching the tail end.", "de", "en"),
        ("Let me check the calendar.", "ar", "en"),
        ("Ja.", "de", "de"),  # too short to flip
        ("Ja.", "en", "en"),
        ("", "de", "de"),
        ("3.5", "de", "de"),
        ("Hi Yousef,", "en", "en"),
        ("Alles klar, bis dann.", "en", "de"),
        ("Bye, Yousef.", "ar", "en"),  # Latin after Arabic → back to a Latin candidate
    ],
)
def test_detect(det: LanguageDetector, text: str, prev: str, want: str):
    assert det.detect(text, prev) == want


def test_script_beats_classifier_and_unknown_scripts_keep_previous(det: LanguageDetector):
    assert det.detect("Привет, как дела?", "en") == "ru"  # script wins even outside the candidates
    assert det.detect("שלום", "de") == "he"


def test_single_latin_candidate_needs_no_classifier():
    d = LanguageDetector(("en", "ar"))
    assert d._ident is None
    assert d.detect("Ich bin Al. Das ist ein Test.", "en") == "en"
    assert d.detect("أهلاً", "en") == "ar"


def test_fillers_exist_for_every_default_language():
    for lang in ("en", "ar", "de"):
        assert FILLERS[lang]


class _Sink:
    def __init__(self):
        self.frames: list[Frame] = []


async def _run(router: LanguageRouter, frames: list[Frame], directions: list | None = None) -> list[Frame]:
    out: list[Frame] = []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        out.append(frame)
        if directions is not None:
            directions.append((frame, direction))

    router.push_frame = push  # type: ignore[method-assign]
    # Bypass FrameProcessor plumbing: process_frame's super() call only bookkeeps.
    from pipecat.processors.frame_processor import FrameProcessor

    async def noop(self, frame, direction):
        return None

    orig = FrameProcessor.process_frame
    FrameProcessor.process_frame = noop  # type: ignore[assignment]
    try:
        for f in frames:
            await router.process_frame(f, FrameDirection.DOWNSTREAM)
    finally:
        FrameProcessor.process_frame = orig  # type: ignore[assignment]
    return out


@pytest.mark.asyncio
async def test_router_switches_language_once_per_change_and_keeps_sentences_whole():
    router = LanguageRouter(("en", "ar", "de"))
    tokens = ["Got", " it.", " تمام", "، أنا", " بتكلم معاك", " بالعربي.", " Ich", " bin Al.", " Das ist", " ein Test."]
    dirs: list = []
    out = await _run(router, [LLMFullResponseStartFrame(), *[LLMTextFrame(t) for t in tokens], LLMFullResponseEndFrame()], dirs)
    texts = [f.text for f in out if isinstance(f, LLMTextFrame)]
    langs = [f.delta.language for f in out if isinstance(f, TTSUpdateSettingsFrame)]
    # the STT is steered too, upstream, with the same language
    stt = [(f.delta.language, d) for f, d in dirs if isinstance(f, STTUpdateSettingsFrame)]
    assert stt == [("ar", FrameDirection.UPSTREAM), ("de", FrameDirection.UPSTREAM)]
    assert texts == ["Got it. ", "تمام، أنا بتكلم معاك بالعربي. ", "Ich bin Al. ", "Das ist ein Test. "]
    assert all(f.includes_inter_frame_spaces for f in out if isinstance(f, LLMTextFrame))
    assert langs == ["ar", "de"]
    # settings frames (TTS, then STT upstream) precede the sentence they apply to
    idx_ar = next(i for i, f in enumerate(out) if isinstance(f, TTSUpdateSettingsFrame) and f.delta.language == "ar")
    assert isinstance(out[idx_ar + 1], STTUpdateSettingsFrame)
    assert isinstance(out[idx_ar + 2], LLMTextFrame) and out[idx_ar + 2].text.startswith("تمام")
    assert router.language == "de"
    assert router.switches == 2
    assert isinstance(out[-1], LLMFullResponseEndFrame)


@pytest.mark.asyncio
async def test_router_flushes_trailing_text_without_terminator():
    router = LanguageRouter(("en", "de"))
    out = await _run(router, [LLMFullResponseStartFrame(), LLMTextFrame("Hallo Yousef, wie geht es dir"), LLMFullResponseEndFrame()])
    texts = [f.text for f in out if isinstance(f, LLMTextFrame)]
    assert texts == ["Hallo Yousef, wie geht es dir "]
    assert router.language == "de"
    assert router.filler() in FILLERS["de"]


@pytest.mark.asyncio
async def test_segment_end_releases_the_sentence_held_for_lookahead():
    # Call 0074df98: the pre-tool line ends in '.', the post-tool text starts
    # with a letter and no space, so without a segment boundary the aggregator
    # emits 'calendar.Nothing' as one token and the TTS says "calendar dot nothing".
    pre = ["Hold", " on", ",", " let", " me", " check", " your", " calendar", "."]
    post = ["Nothing", " on", " your", " calendar", " today", "."]
    glued = await _run(LanguageRouter(("en", "de")), [LLMFullResponseStartFrame(), *map(LLMTextFrame, pre + post), LLMFullResponseEndFrame()])
    assert [f.text for f in glued if isinstance(f, LLMTextFrame)] == ["Hold on, let me check your calendar.Nothing on your calendar today. "]

    out = await _run(LanguageRouter(("en", "de")), [LLMFullResponseStartFrame(), *map(LLMTextFrame, pre), SegmentEndFrame(), *map(LLMTextFrame, post), LLMFullResponseEndFrame()])
    assert [f.text for f in out if isinstance(f, LLMTextFrame)] == ["Hold on, let me check your calendar. ", "Nothing on your calendar today. "]
    assert not any(isinstance(f, SegmentEndFrame) for f in out)


@pytest.mark.asyncio
async def test_segment_end_with_nothing_held_is_a_no_op():
    out = await _run(LanguageRouter(("en", "de")), [LLMFullResponseStartFrame(), SegmentEndFrame(), LLMTextFrame("Let me check"), SegmentEndFrame(), SegmentEndFrame(), LLMFullResponseEndFrame()])
    assert [f.text for f in out if isinstance(f, LLMTextFrame)] == ["Let me check "]


@pytest.mark.asyncio
async def test_router_can_leave_the_stt_alone_and_detects_italian_in_the_wide_set():
    router = LanguageRouter(("en", "ar", "de", "it", "fr", "es"), steer_stt=False)
    dirs: list = []
    out = await _run(router, [LLMFullResponseStartFrame(), LLMTextFrame("Va bene, passiamo all'italiano allora."), LLMFullResponseEndFrame()], dirs)
    assert [f.delta.language for f in out if isinstance(f, TTSUpdateSettingsFrame)] == ["it"]
    assert not any(isinstance(f, STTUpdateSettingsFrame) for f in out)
    assert router.language == "it"
    assert router.filler() in FILLERS["it"]
