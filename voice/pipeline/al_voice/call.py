"""One call = one Pipecat pipeline over one sidecar slot.

VAD → Cartesia Ink STT → the AL voice fork (hub, `ForkLLMService`) → language
router → Cartesia TTS in Yousef's clone → the slot. The pipeline is built and
STARTED at ring time (`prepare`), so the STT/TTS sockets are open and the fork
is warm before the first word; `go` on `accepted` only sends the opening cue.
(Call 2 on 2026-09-20: a 7 s Cartesia connect after `accepted` delayed the
greeting until after Yousef's "Hello?", and both replies played back to back.)"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMAssistantAggregatorParams,
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.cartesia.stt import CartesiaSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService, CartesiaTTSSettings
from pipecat.services.tts_service import TextAggregationMode
from pipecat.turns.user_start.min_words_user_turn_start_strategy import MinWordsUserTurnStartStrategy
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.string import TextPartForConcatenation, concatenate_aggregated_text

from .config import Config
from .fork_llm import ForkLLMService
from .hub import HubClient
from .language import LanguageRouter
from .sidecar import SidecarClient
from .transport import SAMPLE_RATE, CallLatency, WhatsAppCallTransport

# The caller asked for the line to drop. The fork is told to hang up itself;
# this is the safety net when it does not (call 2: "it's just... hang up" was
# answered and the call stayed up).
HANGUP_RE = re.compile(
    r"\b(hang up|hangup|end (?:the|this) call|leg auf|aufh[äa]ngen|auflegen)\b|اقفل|أقفل|اقفلي|إقفل",
    re.I,
)

ANSWERED_CUE = "(The call was answered.)"
SILENT_CUE = "(The caller has said nothing for two seconds.)"


class CartesiaSTT(CartesiaSTTService):
    """Cartesia's STT socket rejects `language=auto` outright (1008 "Invalid
    language") and `ink-2` rejects any non-English language; omitting the
    parameter is what auto-detection is. Pipecat always sends it, so strip it
    from the URL when the configured language is `auto`."""

    async def _websocket_connect(self, url: str, **kwargs):
        if self._settings.language in ("auto", None, ""):
            url = url.replace("&language=auto", "").replace("&language=None", "").replace("&language=", "")
        return await super()._websocket_connect(url, **kwargs)


class TranscriptCollector(FrameProcessor):
    """Sits right after the transport output: `TTSTextFrame`s arrive in step
    with playout, so an interrupted reply records only what was heard — and
    `heard_so_far()` is what the fork is told it was cut off after. User turns
    come from the user aggregator's `on_user_turn_stopped` event. Also watches
    the bot-speaking frames for the graceful hangup."""

    def __init__(self, started_at: float):
        super().__init__()
        self.turns: list[dict[str, Any]] = []
        self._started_at = started_at
        self._bot_parts: list[TextPartForConcatenation] = []
        self._bot_t: float | None = None
        self.bot_speaking = False
        self.last_bot_stopped_at: float | None = None
        self.on_bot_stopped: list[Any] = []
        self.user_spoke = False

    def _t(self) -> int:
        return int((time.time() - self._started_at) * 1000)

    def heard_so_far(self) -> str:
        return concatenate_aggregated_text(self._bot_parts).strip() if self._bot_parts else ""

    def add_user(self, text: str) -> None:
        self._flush_bot()
        if text.strip():
            self.turns.append({"role": "user", "text": text.strip(), "t": self._t()})

    def _flush_bot(self) -> None:
        text = self.heard_so_far()
        if text:
            self.turns.append({"role": "assistant", "text": text, "t": self._bot_t if self._bot_t is not None else self._t()})
        self._bot_parts.clear()
        self._bot_t = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSTextFrame):
            if self._bot_t is None:
                self._bot_t = self._t()
            self._bot_parts.append(TextPartForConcatenation(frame.text, frame.includes_inter_frame_spaces))
        elif isinstance(frame, (VADUserStartedSpeakingFrame, UserStartedSpeakingFrame)):
            # VAD first: the turn start itself waits for words (min-words strategy).
            self.user_spoke = True
        elif isinstance(frame, BotStartedSpeakingFrame):
            self.bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot_speaking = False
            self.last_bot_stopped_at = time.monotonic()
            for cb in list(self.on_bot_stopped):
                try:
                    cb()
                except Exception:  # noqa: BLE001
                    logger.exception("on_bot_stopped callback failed")
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._flush_bot()
        await self.push_frame(frame, direction)


class CallSession:
    def __init__(
        self,
        *,
        cfg: Config,
        sidecar: SidecarClient,
        hub: HubClient,
        call_id: str,
        slot: int,
        jid: str,
        direction: str,
        session: dict[str, Any],
        task: str | None = None,
        tts_languages: tuple[str, ...] | None = None,
    ):
        self.cfg = cfg
        self.sidecar = sidecar
        self.hub = hub
        self.call_id = call_id
        self.slot = slot
        self.jid = jid
        self.direction = direction
        self.session = session
        self.task = task
        self.tts_languages = tts_languages or cfg.tts_languages
        self.started_at = time.time()
        self.prepared_at: float | None = None
        self.live_at: float | None = None
        self.latency = CallLatency()
        self.outcome = "completed"
        self.end_reason: str | None = None
        self._pipeline_task: PipelineTask | None = None
        self._runner_task: asyncio.Task | None = None
        self._transport: WhatsAppCallTransport | None = None
        self._collector: TranscriptCollector | None = None
        self._router: LanguageRouter | None = None
        self._llm: ForkLLMService | None = None
        self._done = asyncio.Event()
        self._hangup_requested = False
        self._hangup_after_reply = False
        self._hangup_task: asyncio.Task | None = None
        self._greet_task: asyncio.Task | None = None

    @property
    def display_name(self) -> str:
        return self.session.get("displayName") or self.jid

    @property
    def fork_session_id(self) -> str | None:
        return self.session.get("forkSessionId")

    # ---- pipeline ----

    def _build(self) -> PipelineTask:
        cfg = self.cfg
        self._transport = WhatsAppCallTransport(self.sidecar, self.slot, self.call_id, self.latency)

        stt_settings = CartesiaSTTService.Settings(model=cfg.cartesia_stt_model, language=cfg.stt_language)
        stt = CartesiaSTT(api_key=cfg.cartesia_api_key, sample_rate=SAMPLE_RATE, settings=stt_settings)

        # TOKEN mode: the language router already delivers whole sentences (and
        # switches the Cartesia context between them); a second sentence
        # aggregator here would hold each one back until the next began.
        tts = CartesiaTTSService(
            api_key=cfg.cartesia_api_key,
            sample_rate=SAMPLE_RATE,
            text_aggregation_mode=TextAggregationMode.TOKEN,
            settings=CartesiaTTSSettings(voice=cfg.cartesia_voice_id, model=cfg.cartesia_tts_model, language="en"),
        )

        self._collector = TranscriptCollector(self.started_at)
        collector = self._collector
        self._router = LanguageRouter(self.tts_languages)
        router = self._router
        self._llm = ForkLLMService(
            hub=self.hub,
            call_id=self.call_id,
            language=lambda: router.language,
            heard=collector.heard_so_far,
            on_turn_done=self._on_turn_done,
        )

        context = LLMContext(messages=[])
        stop_strategies = None
        if cfg.turn_stop == "timeout":
            stop_strategies = [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=cfg.user_speech_timeout)]
        # A user turn starts on WORDS, not on VAD: while AL is talking the
        # caller must say `interrupt_min_words` before it counts as a barge-in
        # (the Nica call: her "Hello?" over the greeting cancelled it), and a
        # single word is enough when AL is quiet.
        # VOICE_INTERRUPT_MIN_WORDS=1 keeps pipecat's default VAD-based start
        # (any sound barges in, and turns end 0.4 s after the caller stops).
        start_strategies = [MinWordsUserTurnStartStrategy(min_words=cfg.interrupt_min_words)] if cfg.interrupt_min_words > 1 else None
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(sample_rate=SAMPLE_RATE, params=VADParams(stop_secs=0.2)),
            user_turn_strategies=UserTurnStrategies(start=start_strategies, stop=stop_strategies),
        )
        aggregators = LLMContextAggregatorPair(context, user_params=user_params, assistant_params=LLMAssistantAggregatorParams())

        @aggregators.user().event_handler("on_user_turn_stopped")
        async def _user_turn(_agg, _strategy, message):
            if message.content:
                text = str(message.content)
                collector.add_user(text)
                if HANGUP_RE.search(text):
                    logger.info(f"[{self.call_id}] caller asked to hang up: {text[:80]!r}")
                    self._hangup_after_reply = True

        pipeline = Pipeline(
            [
                self._transport.input(),
                stt,
                aggregators.user(),
                self._llm,
                self._router,
                tts,
                self._transport.output(),
                self._collector,
                aggregators.assistant(),
            ]
        )
        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                audio_in_sample_rate=SAMPLE_RATE,
                audio_out_sample_rate=SAMPLE_RATE,
                enable_metrics=True,
                enable_usage_metrics=True,
            ),
            idle_timeout_secs=240,
            cancel_on_idle_timeout=True,
            check_dangling_tasks=False,
        )
        return task

    async def prepare(self) -> None:
        """Ring time: build and start the pipeline so every socket is open
        before the peer picks up. Nothing is spoken yet."""
        if self._pipeline_task:
            return
        task = self._build()
        self._pipeline_task = task
        self.prepared_at = time.time()

        @task.event_handler("on_pipeline_finished")
        async def _finished(_task, *_):
            self._done.set()

        @task.event_handler("on_idle_timeout")
        async def _idle(_task, *_):
            logger.warning(f"[{self.call_id}] idle timeout — hanging up")
            self.end_reason = self.end_reason or "idle"
            await self.sidecar.hangup(self.call_id)

        runner = PipelineRunner(handle_sigint=False, handle_sigterm=False, check_dangling_tasks=False)
        self._runner_task = asyncio.create_task(runner.run(task), name=f"call-{self.call_id}")
        asyncio.create_task(self._max_duration_guard(), name=f"maxdur-{self.call_id}")

    async def go(self) -> None:
        """The peer accepted: the call is live. Outbound greets from the task;
        inbound waits for the caller, with the silence cue as fallback."""
        if self.live_at is not None:
            return
        if not self._pipeline_task:
            await self.prepare()
        self.live_at = time.time()
        assert self._pipeline_task is not None
        if self.direction == "out":
            await self._kick(self._pipeline_task, ANSWERED_CUE)
        else:
            self._greet_task = asyncio.create_task(self._greet_if_silent(self._pipeline_task), name=f"greet-{self.call_id}")

    async def _kick(self, task: PipelineTask, cue: str) -> None:
        await task.queue_frames([LLMMessagesAppendFrame([{"role": "user", "content": cue}]), LLMRunFrame()])

    async def _greet_if_silent(self, task: PipelineTask) -> None:
        await asyncio.sleep(self.cfg.inbound_greet_after_secs)
        col = self._collector
        # VAD, not a finished turn: a caller mid-sentence at the 2 s mark is not silent.
        if col and not col.user_spoke and not col.turns and not self._done.is_set():
            await self._kick(task, SILENT_CUE)

    async def _max_duration_guard(self) -> None:
        try:
            await asyncio.wait_for(self._done.wait(), timeout=self.cfg.max_call_secs)
        except asyncio.TimeoutError:
            logger.warning(f"[{self.call_id}] max duration reached — hanging up")
            self.end_reason = self.end_reason or "max-duration"
            await self.sidecar.hangup(self.call_id)

    # ---- hangup ----

    def _on_turn_done(self, outcome: dict[str, Any]) -> None:
        if self._hangup_after_reply and not self._hangup_requested and not outcome.get("cue"):
            self._hangup_after_reply = False
            logger.info(f"[{self.call_id}] safety-net hangup after the reply to a hang-up request")
            self.request_hangup("caller asked")
        elif self._hangup_requested:
            self._maybe_hangup()

    def _speech_pending(self) -> bool:
        """The fork produced text that has not finished playing: still
        generating, audio going out, or a reply whose playout has not started
        (its text came after the bot last stopped speaking)."""
        llm, col = self._llm, self._collector
        if llm is None or col is None:
            return False
        if llm._streaming or col.bot_speaking:
            return True
        if llm.chars_this_response > 0 and llm.response_ended_at is not None:
            return col.last_bot_stopped_at is None or col.last_bot_stopped_at < llm.response_ended_at
        return False

    def _maybe_hangup(self) -> None:
        if not self._hangup_requested or self._done.is_set() or self._speech_pending():
            return
        if self._hangup_task is None or self._hangup_task.done():
            logger.info(f"[{self.call_id}] hanging up")
            self._hangup_task = asyncio.create_task(self.sidecar.hangup(self.call_id), name=f"hangup-{self.call_id}")

    def request_hangup(self, why: str = "requested") -> None:
        """Hang up once AL has finished the sentence being played (or after
        the grace period, whichever is first)."""
        if self._hangup_requested or self._done.is_set():
            return
        self._hangup_requested = True
        self.end_reason = self.end_reason or "hangup"
        logger.info(f"[{self.call_id}] hangup requested ({why}); waiting for playout")
        if self._collector:
            self._collector.on_bot_stopped.append(self._maybe_hangup)

        async def _grace() -> None:
            await asyncio.sleep(self.cfg.hangup_grace_secs)
            if self._done.is_set():
                return
            if self._hangup_task is None or self._hangup_task.done():
                logger.info(f"[{self.call_id}] hangup grace period over — hanging up")
                self._hangup_task = asyncio.create_task(self.sidecar.hangup(self.call_id), name=f"hangup-{self.call_id}")

        asyncio.create_task(_grace(), name=f"hangup-grace-{self.call_id}")
        self._maybe_hangup()

    async def stop(self, reason: str | None) -> None:
        """The sidecar says the call ended (either side). Tear the pipeline down."""
        self.end_reason = self.end_reason or reason
        if self._greet_task:
            self._greet_task.cancel()
        if self._pipeline_task and not self._done.is_set():
            try:
                await asyncio.wait_for(self._pipeline_task.cancel(), timeout=5)
            except Exception:  # noqa: BLE001
                pass
        if self._runner_task:
            try:
                await asyncio.wait_for(self._runner_task, timeout=5)
            except Exception:  # noqa: BLE001
                self._runner_task.cancel()
        if self._transport:
            self._transport.release()
        self._done.set()

    # ---- fold-back ----

    def transcript_payload(self) -> dict[str, Any]:
        ended = time.time()
        live_at = self.live_at or ended
        turns = list(self._collector.turns) if self._collector else []
        return {
            "callId": self.call_id,
            "jid": self.jid,
            "user": self.session.get("user"),
            "displayName": self.display_name,
            "direction": self.direction,
            "outcome": self.outcome,
            "reason": self.end_reason,
            "task": self.task,
            "startedAt": datetime.fromtimestamp(self.started_at, tz=timezone.utc).isoformat(),
            "answeredAt": datetime.fromtimestamp(live_at, tz=timezone.utc).isoformat() if self.live_at else None,
            "durationMs": int((ended - live_at) * 1000) if self.live_at else 0,
            "turns": turns,
            "delegations": 0,
            "toolCalls": self._llm.tool_calls if self._llm else 0,
            "forkSessionId": self.fork_session_id,
            "languageSwitches": self._router.switches if self._router else 0,
            "latency": self.latency.summary(),
            "models": {"stt": self.cfg.cartesia_stt_model, "llm": f"al-fork:{self.session.get('model') or 'al'}", "tts": self.cfg.cartesia_tts_model},
        }
