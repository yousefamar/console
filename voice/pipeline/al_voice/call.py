"""One call = one Pipecat pipeline over one sidecar slot.

VAD → Cartesia Ink STT → the AL voice fork (hub, `ForkLLMService`) → language
router → Cartesia TTS in Yousef's clone → the slot. The pipeline is built and
STARTED at ring time (`prepare`), so the STT/TTS sockets are open and the fork
is warm before the first word; `go` on `accepted` only sends the opening cue.
(Call 2 on 2026-09-20: a 7 s Cartesia connect after `accepted` delayed the
greeting until after Yousef's "Hello?", and both replies played back to back.)

A pipeline that cannot start FAILS LOUD (`fail`): the pre-rendered apology is
played straight to the slot, the call is hung up and the transcript says
`PIPELINE SETUP FAILED: <why>` so AL texts the caller. Call 008048b0
(2026-09-23): Pipecat timed out setting up after Yousef picked up and he heard
33 s of nothing — nothing watched for that."""

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
    ErrorFrame,
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
from pipecat.services.openai.stt import OpenAIRealtimeSTTService
from pipecat.services.tts_service import TextAggregationMode
from pipecat.turns.user_start.min_words_user_turn_start_strategy import MinWordsUserTurnStartStrategy
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.string import TextPartForConcatenation, concatenate_aggregated_text

from .barge_in import SustainedSpeechUserTurnStartStrategy
from .clips import ClipStore
from .config import Config
from .fork_llm import ForkLLMService
from .hub import HubClient
from .language import LanguageRouter
from .sidecar import SidecarClient
from .transport import SAMPLE_RATE, CallLatency, WhatsAppCallTransport, play_pcm

# The caller asked for the line to drop. The fork is told to hang up itself;
# this is the safety net when it does not (call 2: "it's just... hang up" was
# answered and the call stayed up).
HANGUP_RE = re.compile(
    r"\b(hang up|hangup|end (?:the|this) call|leg auf|aufh[äa]ngen|auflegen)\b|اقفل|أقفل|اقفلي|إقفل",
    re.I,
)

ANSWERED_CUE = "(The call was answered.)"
SILENT_CUE = "(The caller has said nothing for two seconds.)"


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
        clips: ClipStore | None = None,
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
        self.clips = clips
        self.started_at = time.time()
        self.prepared_at: float | None = None
        self.ready_at: float | None = None
        self.live_at: float | None = None
        self.latency = CallLatency()
        self.outcome = "completed"
        self.end_reason: str | None = None
        self.failed: str | None = None
        self.ready = asyncio.Event()
        self._pipeline_task: PipelineTask | None = None
        self._runner_task: asyncio.Task | None = None
        self._transport: WhatsAppCallTransport | None = None
        self._collector: TranscriptCollector | None = None
        self._router: LanguageRouter | None = None
        self._llm: ForkLLMService | None = None
        self._done = asyncio.Event()
        self._stopping = False
        self._hangup_requested = False
        self._hangup_after_reply = False
        self._hangup_task: asyncio.Task | None = None
        self._greet_task: asyncio.Task | None = None
        self._watchdog_task: asyncio.Task | None = None
        self._fail_task: asyncio.Task | None = None
        self._expect_audio_task: asyncio.Task | None = None
        self._audio_frames_at_turn_start = 0
        self._line_problems: set[str] = set()
        self._setup_started: dict[str, float] = {}
        self.setup_secs: dict[str, float] = {}
        self.setup_cancelled: dict[str, float] = {}
        self.spoken_clips: list[dict[str, Any]] = []

    @property
    def display_name(self) -> str:
        return self.session.get("displayName") or self.jid

    @property
    def fork_session_id(self) -> str | None:
        return self.session.get("forkSessionId")

    # ---- pipeline ----

    def _time_setup(self, proc: FrameProcessor) -> None:
        """Log how long each processor's `setup` (= its connect) takes, and
        remember which ones are still inside it — that is the answer to
        "which processor blocked?" when Pipecat's setup timeout fires."""
        orig = proc.setup
        name = proc.name

        async def setup(params):  # noqa: ANN001
            started = time.monotonic()
            self._setup_started[name] = started
            try:
                await orig(params)
            except asyncio.CancelledError:
                # Pipecat's setup timeout cancels whatever is still connecting.
                self.setup_cancelled[name] = time.monotonic() - started
                raise
            else:
                self.setup_secs[name] = time.monotonic() - started
            finally:
                self._setup_started.pop(name, None)

        proc.setup = setup  # type: ignore[method-assign]

    async def _build(self) -> PipelineTask:
        cfg = self.cfg
        self._transport = WhatsAppCallTransport(self.sidecar, self.slot, self.call_id, self.latency)
        # The ONNX session load is the one synchronous heavyweight here; on a
        # saturated disk it took 26 s in call 008048b0 and, run inline, held
        # the event loop so the `accepted` event itself arrived 8 s late.
        t0 = time.monotonic()
        vad = await asyncio.to_thread(SileroVADAnalyzer, sample_rate=SAMPLE_RATE, params=VADParams(stop_secs=0.2))
        self.setup_secs["SileroVAD"] = time.monotonic() - t0

        initial_language = self.session.get("language") or cfg.stt_language
        if cfg.stt_vendor == "openai":
            # Language omitted = OpenAI auto-detects per utterance; the router
            # need not steer it.
            stt = OpenAIRealtimeSTTService(
                api_key=cfg.openai_api_key,
                sample_rate=SAMPLE_RATE,
                settings=OpenAIRealtimeSTTService.Settings(model=cfg.openai_stt_model, language=None, noise_reduction="far_field"),
            )
            steer_stt = False
        else:
            # Cartesia STT has no language auto-detect (the parameter "defaults
            # to en"); it starts in the caller's language and the router moves
            # it to follow whatever language AL speaks.
            stt_settings = CartesiaSTTService.Settings(model=cfg.cartesia_stt_model, language=initial_language)
            stt = CartesiaSTTService(api_key=cfg.cartesia_api_key, sample_rate=SAMPLE_RATE, settings=stt_settings)
            steer_stt = True

        # TOKEN mode: the language router already delivers whole sentences (and
        # switches the Cartesia context between them); a second sentence
        # aggregator here would hold each one back until the next began.
        tts = CartesiaTTSService(
            api_key=cfg.cartesia_api_key,
            url=cfg.cartesia_tts_url,
            sample_rate=SAMPLE_RATE,
            text_aggregation_mode=TextAggregationMode.TOKEN,
            settings=CartesiaTTSSettings(voice=cfg.cartesia_voice_id, model=cfg.cartesia_tts_model, language="en"),
        )

        self._collector = TranscriptCollector(self.started_at)
        collector = self._collector
        self._router = LanguageRouter((*self.tts_languages, *cfg.extra_languages), initial=initial_language, steer_stt=steer_stt)
        router = self._router
        self._llm = ForkLLMService(
            hub=self.hub,
            call_id=self.call_id,
            language=lambda: router.language,
            heard=collector.heard_so_far,
            on_turn_done=self._on_turn_done,
            on_turn_start=self._on_turn_start,
        )

        context = LLMContext(messages=[])
        stop_strategies = None
        if cfg.turn_stop == "timeout":
            stop_strategies = [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=cfg.user_speech_timeout)]
        # While AL is talking the caller barges in with `interrupt_min_secs` of
        # continuous speech (VAD — the STT sends no interims, so words alone
        # only ever cut him off after the caller has finished) or with
        # `interrupt_min_words` in the final transcript; a one-word "Hello?"
        # over the greeting (the Nica call) cancels nothing. Any speech starts
        # a turn when AL is quiet. VOICE_INTERRUPT_MIN_WORDS=1 keeps pipecat's
        # default VAD-based start (any sound barges in).
        start_strategies = None
        if cfg.interrupt_min_words > 1:
            start_strategies = [MinWordsUserTurnStartStrategy(min_words=cfg.interrupt_min_words)]
            if cfg.interrupt_min_secs > 0:
                start_strategies.insert(0, SustainedSpeechUserTurnStartStrategy(min_secs=cfg.interrupt_min_secs))
        user_params = LLMUserAggregatorParams(
            vad_analyzer=vad,
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

        # A Cartesia socket that fails to open while the pipeline is being set
        # up leaves it deaf or mute; Pipecat itself just logs and carries on.
        for svc in (stt, tts):

            @svc.event_handler("on_connection_error")
            async def _conn_error(service, error, *_):
                if self.ready.is_set():
                    logger.warning(f"[{self.call_id}] {service.name} connection error mid-call: {error}")
                else:
                    self.fail(f"{service.name} could not connect: {error}")

        processors = [
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
        for p in processors:
            self._time_setup(p)
        pipeline = Pipeline(processors)
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
            setup_timeout_secs=cfg.setup_timeout_secs,
        )
        return task

    def _setup_report(self) -> str:
        slow = sorted(((n, s) for n, s in self.setup_secs.items() if s >= 0.05), key=lambda x: -x[1])
        return ", ".join(f"{n.split('#')[0]} {s:.1f} s" for n, s in slow) or "all < 50 ms"

    def _still_connecting(self) -> str:
        now = time.monotonic()
        parts = [f"{n.split('#')[0]} ({now - t:.0f} s)" for n, t in self._setup_started.items()]
        parts += [f"{n.split('#')[0]} (cancelled after {s:.0f} s)" for n, s in self.setup_cancelled.items()]
        return ", ".join(parts) or "nothing"

    async def prepare(self) -> None:
        """Ring time: build and start the pipeline so every socket is open
        before the peer picks up. Nothing is spoken yet."""
        if self._pipeline_task or self.failed:
            return
        task = await self._build()
        if self.failed or self._stopping:
            return
        self._pipeline_task = task
        self.prepared_at = time.time()

        @task.event_handler("on_pipeline_started")
        async def _started(_task, *_):
            self.ready_at = time.time()
            self.ready.set()
            since = f"{self.ready_at - self.prepared_at:.1f} s after prepare" if self.prepared_at else ""
            live = f", {self.ready_at - self.live_at:.1f} s after pickup" if self.live_at else ""
            logger.info(f"[{self.call_id}] pipeline ready {since}{live} (setup: {self._setup_report()})")

        @task.event_handler("on_setup_timeout")
        async def _setup_timeout(_task, *_):
            self.fail(f"pipeline setup timed out after {self.cfg.setup_timeout_secs:.0f} s; still connecting: {self._still_connecting()}; done: {self._setup_report()}")

        @task.event_handler("on_pipeline_timeout")
        async def _pipeline_timeout(_task, frame=None, *_):
            if not self.ready.is_set():
                self.fail(f"{type(frame).__name__ if frame else 'StartFrame'} never reached the end of the pipeline")

        @task.event_handler("on_pipeline_error")
        async def _pipeline_error(_task, frame: ErrorFrame, *_):
            proc = getattr(frame.processor, "name", "?") if getattr(frame, "processor", None) else "?"
            logger.warning(f"[{self.call_id}] pipeline error from {proc}{' (fatal)' if frame.fatal else ''}: {frame.error}")
            if frame.fatal and not self._stopping:
                self.fail(f"{proc}: {frame.error}")

        @task.event_handler("on_pipeline_finished")
        async def _finished(_task, *_):
            self._done.set()
            if not self._stopping and self.end_reason is None and not self.failed:
                self.fail("the pipeline stopped on its own mid-call")

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
        inbound waits for the caller, with the silence cue as fallback. A
        pipeline that is not ready yet gets a watchdog: the hold-on clip, then
        the apology + hangup if it never comes up."""
        if self.live_at is not None:
            return
        self.live_at = time.time()
        if self.failed:
            self._run_failure()
            return
        if not self._pipeline_task:
            asyncio.create_task(self.prepare(), name=f"prepare-late-{self.call_id}")
        self._watchdog_task = asyncio.create_task(self._ready_watchdog(), name=f"ready-{self.call_id}")

    async def _ready_watchdog(self) -> None:
        cfg = self.cfg
        try:
            await asyncio.wait_for(self.ready.wait(), timeout=cfg.hold_on_after_secs)
        except asyncio.TimeoutError:
            if self._done.is_set() or self.failed:
                return
            logger.warning(f"[{self.call_id}] pipeline not ready {cfg.hold_on_after_secs:.0f} s after pickup (still connecting: {self._still_connecting()}) — playing the hold-on clip")
            asyncio.create_task(self._play_clip("hold_on"), name=f"holdon-{self.call_id}")
            try:
                await asyncio.wait_for(self.ready.wait(), timeout=max(0.0, cfg.setup_grace_secs - cfg.hold_on_after_secs))
            except asyncio.TimeoutError:
                if self._done.is_set() or self.failed:
                    return
                self.fail(f"pipeline not ready {cfg.setup_grace_secs:.0f} s after pickup; still connecting: {self._still_connecting()}; done: {self._setup_report()}")
                return
        if self._done.is_set() or self.failed:
            return
        assert self._pipeline_task is not None
        if self.direction == "out":
            await self._kick(self._pipeline_task, ANSWERED_CUE)
        else:
            self._greet_task = asyncio.create_task(self._greet_if_silent(self._pipeline_task), name=f"greet-{self.call_id}")

    # ---- failing loud ----

    def fail(self, why: str) -> None:
        """The pipeline cannot carry this call. Say so to the caller (the
        pre-rendered apology, no live TTS needed), hang up, and make the
        transcript say PIPELINE SETUP FAILED so AL texts them. Idempotent."""
        if self.failed or self._stopping:
            return
        self.failed = why
        self.outcome = "failed"
        self.end_reason = f"PIPELINE SETUP FAILED: {why}"
        logger.error(f"[{self.call_id}] {self.end_reason}")
        self._done.set()
        for t in (self._greet_task, self._watchdog_task):
            if t and t is not asyncio.current_task():
                t.cancel()
        if self.live_at is not None:
            self._run_failure()
        else:
            # Still ringing: nothing can be said; stop the ring so they see a
            # missed call, not a pickup into silence. A race where they answer
            # first lands in `go`, which plays the apology.
            self._fail_task = asyncio.create_task(self.sidecar.hangup(self.call_id), name=f"fail-hangup-{self.call_id}")

    def _run_failure(self) -> None:
        if self._fail_task and not self._fail_task.done():
            return

        async def run() -> None:
            await self._play_clip("apology")
            await self.sidecar.hangup(self.call_id)

        self._fail_task = asyncio.create_task(run(), name=f"fail-{self.call_id}")

    async def _play_clip(self, name: str) -> None:
        clip = self.clips.get(name, self.session.get("language") or self.cfg.stt_language) if self.clips else None
        if clip is None:
            logger.error(f"[{self.call_id}] no pre-rendered '{name}' clip — the caller hears nothing")
            return
        text, pcm = clip
        t = int((time.time() - self.started_at) * 1000)
        try:
            secs = await play_pcm(self.sidecar, self.slot, pcm)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[{self.call_id}] playing the '{name}' clip failed: {e!r}")
            return
        if secs:
            self.spoken_clips.append({"role": "assistant", "text": text, "t": t, "clip": name})
            logger.info(f"[{self.call_id}] played the '{name}' clip ({secs:.1f} s): {text!r}")

    async def _kick(self, task: PipelineTask, cue: str) -> None:
        await task.queue_frames([LLMMessagesAppendFrame([{"role": "user", "content": cue}]), LLMRunFrame()])

    async def _greet_if_silent(self, task: PipelineTask) -> None:
        await asyncio.sleep(self.cfg.inbound_greet_after_secs)
        col = self._collector
        # VAD, not a finished turn: a caller mid-sentence at the 2 s mark is not silent.
        if col and not col.user_spoke and not col.turns and not self._done.is_set():
            await self._kick(task, SILENT_CUE)

    async def notify_line_problem(self, kind: str, issue: str) -> None:
        """The sidecar says the line is broken (call 00357d4b: 11 turns against
        a dead outbound path, nobody told the fork). Once per problem kind."""
        if kind in self._line_problems or self._done.is_set() or not self._pipeline_task:
            return
        self._line_problems.add(kind)
        logger.warning(f"[{self.call_id}] line problem ({kind}): {issue}")
        if self.live_at is None:
            return
        if kind == "outbound-lost":
            # Our own speech is being binned before the wire: nothing the fork
            # says can reach them, so do not ask it to explain — end the call
            # and let AL text. (The inbound alarms stay a cue: the caller being
            # quiet for 4 s is normal, and the fork can ask.)
            self.fail(f"outbound audio is being discarded ({issue})")
            return
        await self._kick(
            self._pipeline_task,
            f"(Line problem — {issue}. If the caller does not seem to hear you, tell them briefly the line is broken and you'll follow up by message, then hang up.)",
        )

    async def _max_duration_guard(self) -> None:
        try:
            await asyncio.wait_for(self._done.wait(), timeout=self.cfg.max_call_secs)
        except asyncio.TimeoutError:
            logger.warning(f"[{self.call_id}] max duration reached — hanging up")
            self.end_reason = self.end_reason or "max-duration"
            await self.sidecar.hangup(self.call_id)

    # ---- hangup ----

    def _audio_frames(self) -> int:
        return self._transport.output().audio_frames if self._transport else 0

    def _on_turn_start(self) -> None:
        self._audio_frames_at_turn_start = self._audio_frames()

    def _on_turn_done(self, outcome: dict[str, Any]) -> None:
        if outcome.get("spokenChars") and not outcome.get("interrupted") and not self._done.is_set():
            self._expect_audio_task = asyncio.create_task(self._expect_audio(int(outcome["spokenChars"])), name=f"expect-audio-{self.call_id}")
        if self._hangup_after_reply and not self._hangup_requested and not outcome.get("cue"):
            self._hangup_after_reply = False
            logger.info(f"[{self.call_id}] safety-net hangup after the reply to a hang-up request")
            self.request_hangup("caller asked")
        elif self._hangup_requested:
            self._maybe_hangup()

    async def _expect_audio(self, chars: int) -> None:
        """The fork said something: its TTS audio must reach the slot. A turn
        whose text produces no audio at all is a mute call the sidecar cannot
        see (nothing is lost from its side) — fail loud instead of letting the
        caller listen to silence."""
        deadline = time.monotonic() + self.cfg.tts_audio_timeout_secs
        while time.monotonic() < deadline:
            if self._done.is_set() or self._audio_frames() > self._audio_frames_at_turn_start:
                return
            await asyncio.sleep(0.25)
        if self._done.is_set() or self._audio_frames() > self._audio_frames_at_turn_start:
            return
        self.fail(f"TTS produced no audio for a spoken turn ({chars} chars, {self.cfg.tts_audio_timeout_secs:.0f} s)")

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
        self._stopping = True
        self.end_reason = self.end_reason or reason
        for t in (self._greet_task, self._watchdog_task, self._fail_task, self._expect_audio_task):
            if t:
                t.cancel()
        # `_done` is also set by `fail`, so judge by the runner: a pipeline that
        # was still setting up when the call failed is still running here.
        if self._pipeline_task and self._runner_task and not self._runner_task.done():
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
        if self.spoken_clips:
            turns = sorted([*turns, *self.spoken_clips], key=lambda t: t.get("t", 0))
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
            "failed": self.failed,
            "setup": {
                "readyMs": int((self.ready_at - self.prepared_at) * 1000) if self.ready_at and self.prepared_at else None,
                "readyAfterPickupMs": int((self.ready_at - self.live_at) * 1000) if self.ready_at and self.live_at else None,
                "secs": {k.split("#")[0]: round(v, 3) for k, v in self.setup_secs.items()},
                "stillConnecting": [k.split("#")[0] for k in (*self._setup_started, *self.setup_cancelled)],
            },
            "lineProblems": sorted(self._line_problems),
            "delegations": 0,
            "toolCalls": self._llm.tool_calls if self._llm else 0,
            "forkSessionId": self.fork_session_id,
            "languageSwitches": self._router.switches if self._router else 0,
            "latency": self.latency.summary(),
            "models": {"stt": f"{self.cfg.stt_vendor}:{self.cfg.openai_stt_model if self.cfg.stt_vendor == 'openai' else self.cfg.cartesia_stt_model}", "llm": f"al-fork:{self.session.get('model') or 'al'}", "tts": self.cfg.cartesia_tts_model},
            "languages": {"initial": self.session.get("language") or self.cfg.stt_language, "final": self._router.language if self._router else None, "candidates": list(self._router.detector.candidates) if self._router else []},
        }
