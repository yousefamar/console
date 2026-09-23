"""The fail-loud path (call 008048b0, 23 Sept 2026: 33 s of dead air after
Pipecat's setup timeout). No network, no Pipecat pipeline: a fake sidecar
records what left for the slot, a fake clip store hands out a known PCM."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from al_voice import transport
from al_voice.call import CallSession
from al_voice.clips import CLIP_TEXTS, ClipStore, clip_text
from al_voice.config import Config

FRAME = transport.FRAME_BYTES


class FakeSidecar:
    def __init__(self, accept_audio: bool = True):
        self.audio: list[tuple[int, bytes]] = []
        self.hangups: list[str] = []
        self.accept_audio = accept_audio
        self.hung_up = asyncio.Event()

    async def send_audio(self, slot: int, pcm: bytes) -> bool:
        if not self.accept_audio:
            return False
        self.audio.append((slot, pcm))
        return True

    async def hangup(self, call_id: str) -> None:
        self.hangups.append(call_id)
        self.hung_up.set()

    def bind_slot(self, *_): ...
    def unbind_slot(self, *_): ...


class FakeClips:
    def __init__(self, seconds: float = 0.3):
        self.pcm = bytes(range(256)) * (int(16000 * seconds * 2) // 256)
        self.asked: list[tuple[str, str | None]] = []

    def get(self, name: str, language: str | None):
        self.asked.append((name, language))
        return clip_text(name, language)[1], self.pcm


def make_call(sidecar, clips, **cfg_overrides) -> CallSession:
    cfg = Config(**cfg_overrides)
    return CallSession(
        cfg=cfg, sidecar=sidecar, hub=None, call_id="CALL1", slot=3, jid="447845443890@s.whatsapp.net",
        direction="out", session={"displayName": "Yousef", "language": "en"}, task="test", clips=clips,
    )


@pytest.fixture(autouse=True)
def fast_playout(monkeypatch):
    # Real-time pacing is the transport's job; the tests care about what was
    # sent. Only the clip's own duration is waited for.
    monkeypatch.setattr(transport, "LEAD_SECS", 10_000.0)
    monkeypatch.setattr(transport, "PREROLL_SECS", 0.0)
    monkeypatch.setattr(transport, "TAIL_SECS", 0.0)


@pytest.mark.asyncio
async def test_fail_while_live_plays_apology_then_hangs_up_and_reports_failed():
    side, clips = FakeSidecar(), FakeClips(seconds=0.3)
    call = make_call(side, clips)
    call.live_at = call.started_at

    call.fail("pipeline setup timed out after 20 s; still connecting: CartesiaTTSService (20 s)")
    await asyncio.wait_for(side.hung_up.wait(), 2)

    assert side.hangups == ["CALL1"]
    assert side.audio, "the apology went to the slot"
    assert {slot for slot, _ in side.audio} == {3}
    assert all(len(pcm) == FRAME for _, pcm in side.audio), "60 ms frames"
    assert b"".join(pcm for _, pcm in side.audio).startswith(clips.pcm)
    assert clips.asked == [("apology", "en")]

    payload = call.transcript_payload()
    assert payload["outcome"] == "failed"
    assert payload["reason"].startswith("PIPELINE SETUP FAILED: pipeline setup timed out")
    assert payload["failed"].startswith("pipeline setup timed out")
    assert payload["turns"] == [{"role": "assistant", "text": CLIP_TEXTS["apology"]["en"], "t": payload["turns"][0]["t"], "clip": "apology"}]


@pytest.mark.asyncio
async def test_fail_is_idempotent():
    side, clips = FakeSidecar(), FakeClips()
    call = make_call(side, clips)
    call.live_at = call.started_at
    call.fail("first")
    call.fail("second")
    await asyncio.wait_for(side.hung_up.wait(), 2)
    await asyncio.sleep(0)
    assert call.failed == "first"
    assert side.hangups == ["CALL1"]
    assert clips.asked == [("apology", "en")]


@pytest.mark.asyncio
async def test_fail_while_ringing_hangs_up_without_speaking_and_go_speaks_if_they_answer_first():
    side, clips = FakeSidecar(), FakeClips()
    call = make_call(side, clips)

    call.fail("pipeline could not be built: boom")
    await asyncio.wait_for(side.hung_up.wait(), 2)
    assert side.audio == [] and side.hangups == ["CALL1"]
    assert call.transcript_payload()["outcome"] == "failed"

    # The race: the peer picked up before the hangup landed.
    side.hung_up.clear()
    await call.go()
    await asyncio.wait_for(side.hung_up.wait(), 2)
    assert side.audio, "they answered — they get the apology, not silence"
    assert side.hangups == ["CALL1", "CALL1"]


@pytest.mark.asyncio
async def test_apology_in_the_callers_language_falls_back_to_english():
    side = FakeSidecar()
    store = ClipStore(Config(clips_dir=Path("/nonexistent/voice-clips"), cartesia_voice_id="v", cartesia_tts_model="m"))
    call = make_call(side, store)
    call.session["language"] = "ar"
    call.live_at = call.started_at
    call.fail("x")
    await asyncio.wait_for(side.hung_up.wait(), 2)
    # No clip on disk at all: nothing can be said, but the hangup still happens
    # and the transcript still says so.
    assert side.audio == []
    assert side.hangups == ["CALL1"]
    assert call.transcript_payload()["turns"] == []
    assert store.get("apology", "ar") is None


@pytest.mark.asyncio
async def test_watchdog_hold_on_then_apology_when_the_pipeline_never_comes_up():
    side, clips = FakeSidecar(), FakeClips(seconds=0.12)
    call = make_call(side, clips, hold_on_after_secs=0.05, setup_grace_secs=0.15)
    call._pipeline_task = object()  # "prepared", never ready
    await call.go()
    await asyncio.wait_for(side.hung_up.wait(), 3)
    await asyncio.sleep(0.05)
    assert [n for n, _ in clips.asked] == ["hold_on", "apology"]
    assert call.outcome == "failed"
    assert "not ready" in call.failed
    payload = call.transcript_payload()
    assert [t["clip"] for t in payload["turns"]] == ["hold_on", "apology"]


@pytest.mark.asyncio
async def test_watchdog_stands_down_when_the_pipeline_becomes_ready():
    side, clips = FakeSidecar(), FakeClips()
    call = make_call(side, clips, hold_on_after_secs=0.05, setup_grace_secs=1.0)
    kicked: list[str] = []

    async def fake_kick(_task, cue):
        kicked.append(cue)

    call._kick = fake_kick  # type: ignore[method-assign]
    call._pipeline_task = object()
    await call.go()
    await asyncio.sleep(0.08)  # past the hold-on mark
    call.ready.set()
    await asyncio.sleep(0.05)
    assert [n for n, _ in clips.asked] == ["hold_on"]
    assert kicked == ["(The call was answered.)"], "the greeting still goes out once ready"
    assert call.failed is None and side.hangups == []


@pytest.mark.asyncio
async def test_outbound_lost_line_problem_fails_loud_but_inbound_alarms_only_cue():
    side, clips = FakeSidecar(), FakeClips()
    call = make_call(side, clips)
    call._pipeline_task = object()
    call.live_at = call.started_at
    cues: list[str] = []

    async def fake_kick(_task, cue):
        cues.append(cue)

    call._kick = fake_kick  # type: ignore[method-assign]
    await call.notify_line_problem("inbound-stalled", "no audio has arrived from the caller for 3875")
    assert call.failed is None and len(cues) == 1 and "Line problem" in cues[0]
    await call.notify_line_problem("outbound-lost", "400 speech frames dropped")
    await asyncio.wait_for(side.hung_up.wait(), 2)
    assert call.outcome == "failed" and "outbound audio is being discarded" in call.failed
    assert len(cues) == 1, "the fork is not asked to explain a line it cannot be heard on"


def test_clip_texts_cover_the_voice_languages_and_fall_back():
    for name in ("apology", "hold_on"):
        assert set(CLIP_TEXTS[name]) >= {"en", "ar", "de", "fr", "it", "es"}
        assert clip_text(name, "tr") == ("en", CLIP_TEXTS[name]["en"])
        assert clip_text(name, "ar")[0] == "ar"
        assert clip_text(name, None)[0] == "en"
    assert "text" in CLIP_TEXTS["apology"]["en"].lower(), "the apology promises the text AL's envelope asks for"


@pytest.mark.asyncio
async def test_play_pcm_pads_to_whole_frames_and_stops_when_the_socket_is_gone():
    side = FakeSidecar()
    secs = await transport.play_pcm(side, 1, b"\x01\x02" * 1000)  # 2000 bytes = 1.04 frames
    assert len(side.audio) == 2 and all(len(p) == FRAME for _, p in side.audio)
    assert secs == pytest.approx(0.12)
    dead = FakeSidecar(accept_audio=False)
    assert await transport.play_pcm(dead, 1, b"\0" * FRAME * 3) == 0.0


class _Out:
    def __init__(self):
        self.audio_frames = 0


class _Transport:
    def __init__(self):
        self._out = _Out()

    def output(self):
        return self._out


@pytest.mark.asyncio
async def test_a_spoken_turn_with_no_tts_audio_fails_loud_but_one_with_audio_does_not():
    side, clips = FakeSidecar(), FakeClips()
    call = make_call(side, clips, tts_audio_timeout_secs=0.2)
    call._transport = _Transport()
    call.live_at = call.started_at

    # Turn 1: the fork spoke and audio followed — fine.
    call._on_turn_start()
    call._transport.output().audio_frames += 5
    call._on_turn_done({"type": "result", "spokenChars": 40})
    await asyncio.sleep(0.3)
    assert call.failed is None

    # Turn 2: text, no audio, ever.
    call._on_turn_start()
    call._on_turn_done({"type": "result", "spokenChars": 60})
    await asyncio.wait_for(side.hung_up.wait(), 2)
    assert call.outcome == "failed" and "TTS produced no audio for a spoken turn (60 chars" in call.failed

    # A cue/tool turn with nothing spoken, or an interrupted one, never arms the alarm.
    side2, call2 = FakeSidecar(), make_call(FakeSidecar(), clips, tts_audio_timeout_secs=0.05)
    call2._transport = _Transport()
    call2.live_at = call2.started_at
    call2._on_turn_done({"type": "result", "spokenChars": 0})
    call2._on_turn_done({"type": "result", "spokenChars": 30, "interrupted": True})
    await asyncio.sleep(0.15)
    assert call2.failed is None and side2.hangups == []


def test_loopback_verdict():
    from al_voice.main import loopback_verdict

    clip = 1920 * 35  # 2.1 s
    good = {"frames": 47, "speechFrames": 35, "encodedFrames": 47, "meanSpeechPacket": 80.0, "meanIdlePacket": 127.0, "encodeMsMax": 9.0}
    assert loopback_verdict(good, clip) == (True, None), "packet sizes are not judged (tone < noise floor is normal)"
    ok, why = loopback_verdict({**good, "speechFrames": 6}, clip)
    assert not ok and "only 6 of 35" in why
    ok, why = loopback_verdict({**good, "encodedFrames": 40}, clip)
    assert not ok and "packets for 40 of 47" in why
    ok, why = loopback_verdict({**good, "encodeMsMax": 75.0}, clip)
    assert not ok and "too slow" in why
    assert loopback_verdict({}, clip)[0] is False
