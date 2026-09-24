"""Barge-in that does not wait for the STT.

Cartesia ink-whisper sends no interim transcripts — one final, ~0.4 s after
the caller stops — so a word-count start strategy can only cut AL off once
the caller has finished talking (Yousef, 24 Sept 2026: seven "hello"s over
a sentence, no cut-off). This strategy starts the user turn from the VAD:
immediately while AL is quiet (pipecat's default), and after `min_secs` of
continuous speech while AL is speaking, so a one-word "Hello?"/"yeah" still
does not cancel a sentence (the Nica call) but real talking-over does."""

from __future__ import annotations

import time
from collections.abc import Callable

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InputAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy


class SustainedSpeechUserTurnStartStrategy(BaseUserTurnStartStrategy):
    def __init__(self, *, min_secs: float, clock: Callable[[], float] = time.monotonic, **kwargs):
        super().__init__(**kwargs)
        self._min_secs = min_secs
        self._clock = clock
        self._bot_speaking = False
        self._speech_since: float | None = None

    async def handle_user_turn_started(self):
        self._speech_since = None

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            if not self._bot_speaking:
                await self.trigger_user_turn_started()
                return ProcessFrameResult.STOP
            # The VAD only confirms speech after start_secs of it: count those.
            self._speech_since = self._clock() - frame.start_secs
            return await self._check()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._speech_since = None
        elif isinstance(frame, InputAudioRawFrame):
            return await self._check()
        return ProcessFrameResult.CONTINUE

    async def _check(self) -> ProcessFrameResult:
        if self._speech_since is None:
            return ProcessFrameResult.CONTINUE
        spoken = self._clock() - self._speech_since
        if spoken < self._min_secs:
            return ProcessFrameResult.CONTINUE
        logger.debug(f"{self} barge-in after {spoken:.2f} s of speech over the bot")
        self._speech_since = None
        await self.trigger_user_turn_started()
        return ProcessFrameResult.STOP
