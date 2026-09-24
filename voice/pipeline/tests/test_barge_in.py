"""Barge-in from the VAD alone (call 0074df98, 24 Sept 2026: seven "hello"s
over a sentence, no cut-off — the STT sends no interims, so words only ever
arrive after the caller has finished)."""

from __future__ import annotations

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.turns.types import ProcessFrameResult

from al_voice.barge_in import SustainedSpeechUserTurnStartStrategy

FRAME_SECS = 0.06
VAD_START_SECS = 0.2


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def audio() -> InputAudioRawFrame:
    return InputAudioRawFrame(audio=b"\0" * 1920, sample_rate=16000, num_channels=1)


async def make(min_secs: float = 0.7):
    clock = Clock()
    strategy = SustainedSpeechUserTurnStartStrategy(min_secs=min_secs, clock=clock)
    starts: list[object] = []

    @strategy.event_handler("on_user_turn_started")
    async def _started(_s, params):
        starts.append(params)

    return strategy, clock, starts


async def speak(strategy, clock, secs: float) -> list[ProcessFrameResult]:
    """The caller talks for `secs` after the VAD confirmed speech, one 60 ms frame at a time."""
    results = []
    elapsed = 0.0
    while elapsed < secs:
        clock.now += FRAME_SECS
        elapsed += FRAME_SECS
        results.append(await strategy.process_frame(audio()))
    return results


@pytest.mark.asyncio
async def test_bot_quiet_starts_the_turn_on_vad_start():
    strategy, clock, starts = await make()
    result = await strategy.process_frame(VADUserStartedSpeakingFrame(start_secs=VAD_START_SECS))
    assert result == ProcessFrameResult.STOP
    assert len(starts) == 1


@pytest.mark.asyncio
async def test_short_interjection_over_the_bot_is_ignored():
    strategy, clock, starts = await make()
    await strategy.process_frame(BotStartedSpeakingFrame())
    assert await strategy.process_frame(VADUserStartedSpeakingFrame(start_secs=VAD_START_SECS)) == ProcessFrameResult.CONTINUE
    # "Hello?": ~0.45 s in total, 0.25 s after the VAD confirmed it
    results = await speak(strategy, clock, 0.25)
    assert all(r == ProcessFrameResult.CONTINUE for r in results)
    await strategy.process_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    await speak(strategy, clock, 2.0)
    assert starts == []


@pytest.mark.asyncio
async def test_talking_over_the_bot_cuts_in_after_min_secs():
    strategy, clock, starts = await make(min_secs=0.7)
    await strategy.process_frame(BotStartedSpeakingFrame())
    await strategy.process_frame(VADUserStartedSpeakingFrame(start_secs=VAD_START_SECS))
    results = await speak(strategy, clock, 2.0)
    stop_at = results.index(ProcessFrameResult.STOP)
    # 0.2 s already spoken when the VAD confirmed, so the cut comes ~0.5 s later
    assert 0.42 <= (stop_at + 1) * FRAME_SECS <= 0.56
    assert len(starts) == 1
    # keeps quiet for the rest of the same utterance
    assert results[stop_at + 1 :] and all(r == ProcessFrameResult.CONTINUE for r in results[stop_at + 1 :])


@pytest.mark.asyncio
async def test_a_pause_resets_the_count():
    strategy, clock, starts = await make(min_secs=0.7)
    await strategy.process_frame(BotStartedSpeakingFrame())
    await strategy.process_frame(VADUserStartedSpeakingFrame(start_secs=VAD_START_SECS))
    await speak(strategy, clock, 0.3)
    await strategy.process_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    await strategy.process_frame(VADUserStartedSpeakingFrame(start_secs=VAD_START_SECS))
    results = await speak(strategy, clock, 0.3)
    assert ProcessFrameResult.STOP not in results
    results = await speak(strategy, clock, 0.3)
    assert ProcessFrameResult.STOP in results
    assert len(starts) == 1


@pytest.mark.asyncio
async def test_after_the_bot_stops_any_speech_starts_a_turn():
    strategy, clock, starts = await make()
    await strategy.process_frame(BotStartedSpeakingFrame())
    await strategy.process_frame(BotStoppedSpeakingFrame())
    assert await strategy.process_frame(VADUserStartedSpeakingFrame(start_secs=VAD_START_SECS)) == ProcessFrameResult.STOP
    assert len(starts) == 1
