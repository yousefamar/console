"""One call = one Pipecat pipeline over one sidecar slot.

VAD → Cartesia Ink STT → Claude on Bedrock (streaming, one `delegate` tool)
→ Cartesia TTS in Yousef's clone → the slot. The hub front-loads the whole
system prompt (`GET /voice/context`) and receives the transcript afterwards
(`POST /voice/transcript`); the live AL session is never on the hot path."""

from __future__ import annotations

import asyncio
import random
import time
from datetime import datetime, timezone
from typing import Any

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    LLMTextFrame,
    TTSSpeakFrame,
    TTSTextFrame,
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
from pipecat.services.aws.llm import AWSBedrockLLMService
from pipecat.services.cartesia.stt import CartesiaSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.string import TextPartForConcatenation, concatenate_aggregated_text

from .config import Config
from .hub import HubClient
from .sidecar import SidecarClient
from .transport import SAMPLE_RATE, CallLatency, WhatsAppCallTransport

FILLERS = [
    "One sec.",
    "Let me check.",
    "Hang on a moment.",
    "Give me a second.",
]


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
    with playout, so an interrupted reply records only what was heard. User
    turns come from the user aggregator's `on_user_turn_stopped` event (the
    aggregator consumes `TranscriptionFrame`s; they never reach us here)."""

    def __init__(self, started_at: float):
        super().__init__()
        self.turns: list[dict[str, Any]] = []
        self._started_at = started_at
        self._bot_parts: list[TextPartForConcatenation] = []
        self._bot_t: float | None = None

    def _t(self) -> int:
        return int((time.time() - self._started_at) * 1000)

    def add_user(self, text: str) -> None:
        self._flush_bot()
        if text.strip():
            self.turns.append({"role": "user", "text": text.strip(), "t": self._t()})

    def _flush_bot(self) -> None:
        text = concatenate_aggregated_text(self._bot_parts).strip() if self._bot_parts else ""
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
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._flush_bot()
        await self.push_frame(frame, direction)


class ResponseTextTap(FrameProcessor):
    """Right after the LLM: counts the text generated in the current response
    so the delegate handler knows whether the model already said something
    before calling the tool (then no programmatic filler is needed)."""

    def __init__(self):
        super().__init__()
        self.chars_this_response = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self.chars_this_response = 0
        elif isinstance(frame, LLMTextFrame):
            self.chars_this_response += len(frame.text.strip())
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
        context: dict[str, Any],
        task: str | None = None,
    ):
        self.cfg = cfg
        self.sidecar = sidecar
        self.hub = hub
        self.call_id = call_id
        self.slot = slot
        self.jid = jid
        self.direction = direction
        self.ctx = context
        self.task = task
        self.started_at = time.time()
        self.live_at: float | None = None
        self.latency = CallLatency()
        self.outcome = "completed"
        self.end_reason: str | None = None
        self._pipeline_task: PipelineTask | None = None
        self._runner_task: asyncio.Task | None = None
        self._transport: WhatsAppCallTransport | None = None
        self._collector: TranscriptCollector | None = None
        self._response_tap: ResponseTextTap | None = None
        self._done = asyncio.Event()
        self._delegations = 0

    @property
    def display_name(self) -> str:
        return self.ctx.get("displayName") or self.jid

    # ---- pipeline ----

    def _build(self) -> tuple[PipelineTask, LLMContext]:
        cfg = self.cfg
        self._transport = WhatsAppCallTransport(self.sidecar, self.slot, self.call_id, self.latency)

        stt_settings = CartesiaSTTService.Settings(model=cfg.cartesia_stt_model, language=cfg.stt_language)
        stt = CartesiaSTT(api_key=cfg.cartesia_api_key, sample_rate=SAMPLE_RATE, settings=stt_settings)

        tts = CartesiaTTSService(
            api_key=cfg.cartesia_api_key,
            voice_id=cfg.cartesia_voice_id,
            model=cfg.cartesia_tts_model,
            sample_rate=SAMPLE_RATE,
        )

        # No temperature/top_p: Claude Sonnet 5 on Bedrock rejects them.
        llm = AWSBedrockLLMService(
            aws_region=cfg.aws_region,
            settings=AWSBedrockLLMService.Settings(
                model=cfg.llm_model,
                max_tokens=400,
                system_instruction=self.ctx.get("systemPrompt") or "",
            ),
            retry_on_timeout=True,
            retry_timeout_secs=4.0,
        )

        delegate_schema = FunctionSchema(
            name="delegate",
            description=(
                "Hand a request to your text-based self, who has tools, files, calendar, messaging and memory. "
                "Use it for ANYTHING you cannot answer from the context you already have: looking things up, "
                "checking or changing the calendar, sending messages, reading or writing files, running tasks. "
                "Pass the caller's request clearly and completely, with any names, dates or details they gave."
            ),
            properties={"request": {"type": "string", "description": "The task or question, fully specified."}},
            required=["request"],
            handler=self._on_delegate,
        )
        context = LLMContext(messages=[], tools=[delegate_schema])

        stop_strategies = None
        if cfg.turn_stop == "timeout":
            stop_strategies = [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=cfg.user_speech_timeout)]
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(sample_rate=SAMPLE_RATE, params=VADParams(stop_secs=0.2)),
            user_turn_strategies=UserTurnStrategies(stop=stop_strategies),
        )
        aggregators = LLMContextAggregatorPair(context, user_params=user_params, assistant_params=LLMAssistantAggregatorParams())

        self._collector = TranscriptCollector(self.started_at)
        collector = self._collector
        self._response_tap = ResponseTextTap()

        @aggregators.user().event_handler("on_user_turn_stopped")
        async def _user_turn(_agg, _strategy, message):
            if message.content:
                collector.add_user(str(message.content))
        pipeline = Pipeline(
            [
                self._transport.input(),
                stt,
                aggregators.user(),
                llm,
                self._response_tap,
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
            idle_timeout_secs=180,
            cancel_on_idle_timeout=True,
            check_dangling_tasks=False,
        )
        return task, context

    async def _on_delegate(self, params: FunctionCallParams) -> None:
        request = str(params.arguments.get("request") or "").strip()
        self._delegations += 1
        logger.info(f"[{self.call_id}] delegate #{self._delegations}: {request[:120]!r}")
        if not (self._response_tap and self._response_tap.chars_this_response):
            await params.llm.push_frame(TTSSpeakFrame(random.choice(FILLERS)))
        caller = self.jid.split("@", 1)[0]
        try:
            answer = await self.hub.delegate(request, caller, self.call_id, self.cfg.delegate_timeout_secs)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[{self.call_id}] delegate failed: {e!r}")
            answer = "(the request could not be completed right now; say so briefly and offer to follow up by message)"
        await params.result_callback({"result": answer or "(no answer came back; say so briefly)"})

    async def start(self) -> None:
        task, _context = self._build()
        self._pipeline_task = task
        self.live_at = time.time()

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

        if self.direction == "out":
            await self._kick(task, "(The call has just been answered. Greet them by name and begin the call task.)")
        else:
            asyncio.create_task(self._greet_if_silent(task), name=f"greet-{self.call_id}")

        asyncio.create_task(self._max_duration_guard(), name=f"maxdur-{self.call_id}")

    async def _kick(self, task: PipelineTask, cue: str) -> None:
        await task.queue_frames([LLMMessagesAppendFrame([{"role": "user", "content": cue}]), LLMRunFrame()])

    async def _greet_if_silent(self, task: PipelineTask) -> None:
        await asyncio.sleep(self.cfg.inbound_greet_after_secs)
        if self._collector and not self._collector.turns and not self._done.is_set():
            await self._kick(task, "(You answered and the caller has said nothing for two seconds. Greet them briefly.)")

    async def _max_duration_guard(self) -> None:
        try:
            await asyncio.wait_for(self._done.wait(), timeout=self.cfg.max_call_secs)
        except asyncio.TimeoutError:
            logger.warning(f"[{self.call_id}] max duration reached — hanging up")
            self.end_reason = self.end_reason or "max-duration"
            await self.sidecar.hangup(self.call_id)

    async def stop(self, reason: str | None) -> None:
        """The sidecar says the call ended (either side). Tear the pipeline down."""
        self.end_reason = self.end_reason or reason
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
            "user": self.ctx.get("user"),
            "displayName": self.display_name,
            "direction": self.direction,
            "outcome": self.outcome,
            "reason": self.end_reason,
            "task": self.task,
            "startedAt": datetime.fromtimestamp(self.started_at, tz=timezone.utc).isoformat(),
            "answeredAt": datetime.fromtimestamp(live_at, tz=timezone.utc).isoformat() if self.live_at else None,
            "durationMs": int((ended - live_at) * 1000) if self.live_at else 0,
            "turns": turns,
            "delegations": self._delegations,
            "latency": self.latency.summary(),
            "models": {"stt": self.cfg.cartesia_stt_model, "llm": self.cfg.llm_model, "tts": self.cfg.cartesia_tts_model},
        }
