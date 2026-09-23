"""Pipecat transport over one wa-voice call slot.

Input: the sidecar client hands us the peer's 16 kHz PCM per slot; we wrap it
in `InputAudioRawFrame`s. Output: TTS PCM goes back as binary frames, paced at
real time with a small lead so a barge-in leaves at most ~0.3 s of already
queued speech — and an `InterruptionFrame` flushes even that in the sidecar."""

from __future__ import annotations

import asyncio
import time

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    MetricsFrame,
    OutputAudioRawFrame,
    StartFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import TTFBMetricsData
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams

from .sidecar import SidecarClient

SAMPLE_RATE = 16_000
FRAME_MS = 60
LEAD_SECS = 0.3
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2
# The sidecar may put a noise pre-roll before each utterance (WA_VOICE_ONSET_PREROLL_MS).
PREROLL_SECS = 0.3
TAIL_SECS = 0.4


async def play_pcm(sidecar: SidecarClient, slot: int, pcm: bytes) -> float:
    """Play raw 16 kHz s16le PCM straight to a slot, paced like the transport
    (real time, `LEAD_SECS` ahead), and return only once it has been heard —
    for the pre-rendered clips a call falls back on when its pipeline cannot
    speak. Returns the clip's duration in seconds (0 if nothing was sent)."""
    if len(pcm) % FRAME_BYTES:
        pcm += b"\0" * (FRAME_BYTES - len(pcm) % FRAME_BYTES)
    frames = [pcm[i : i + FRAME_BYTES] for i in range(0, len(pcm), FRAME_BYTES)]
    start = time.monotonic()
    for i, frame in enumerate(frames):
        if not await sidecar.send_audio(slot, frame):
            return 0.0
        ahead = start + (i + 1) * FRAME_MS / 1000 - time.monotonic()
        if ahead > LEAD_SECS:
            await asyncio.sleep(ahead - LEAD_SECS)
    duration = len(frames) * FRAME_MS / 1000
    await asyncio.sleep(max(0.0, start + duration + PREROLL_SECS + TAIL_SECS - time.monotonic()))
    return duration


class CallLatency:
    """End-of-speech → first bot audio, per turn, plus the per-service TTFBs
    Pipecat reports, so the hand-back can say where the time went."""

    def __init__(self) -> None:
        self.turns: list[float] = []
        self.ttfb: dict[str, list[float]] = {}
        self._user_stopped_at: float | None = None

    def user_stopped(self) -> None:
        self._user_stopped_at = time.monotonic()

    def first_audio(self) -> float | None:
        if self._user_stopped_at is None:
            return None
        delta = time.monotonic() - self._user_stopped_at
        self._user_stopped_at = None
        self.turns.append(delta)
        return delta

    def note_metrics(self, frame: MetricsFrame) -> None:
        for d in frame.data:
            if isinstance(d, TTFBMetricsData):
                self.ttfb.setdefault(d.processor.split("#")[0], []).append(d.value)

    def summary(self) -> dict:
        def stats(xs: list[float]) -> dict | None:
            if not xs:
                return None
            xs = sorted(xs)
            return {
                "n": len(xs),
                "median_ms": round(xs[len(xs) // 2] * 1000),
                "p90_ms": round(xs[min(len(xs) - 1, int(len(xs) * 0.9))] * 1000),
                "max_ms": round(xs[-1] * 1000),
            }

        return {
            "eos_to_first_audio": stats(self.turns),
            "ttfb": {k: stats(v) for k, v in self.ttfb.items()},
        }


class WhatsAppCallParams(TransportParams):
    pass


class _Input(BaseInputTransport):
    def __init__(self, params: TransportParams):
        super().__init__(params)
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=200)
        self._pump: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def on_audio(self, pcm: bytes) -> None:
        try:
            self._queue.put_nowait(pcm)
        except asyncio.QueueFull:
            # The pipeline is stalled; VoIP is loss tolerant, drop the oldest.
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(pcm)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass

    async def start(self, frame: StartFrame):
        await super().start(frame)
        self._pump = asyncio.create_task(self._pump_audio(), name="wa-audio-in")
        await self.set_transport_ready(frame)

    async def _pump_audio(self) -> None:
        while True:
            pcm = await self._queue.get()
            if self._params.audio_in_enabled:
                await self.push_audio_frame(InputAudioRawFrame(audio=pcm, sample_rate=SAMPLE_RATE, num_channels=1))

    async def _stop_pump(self) -> None:
        if self._pump:
            self._pump.cancel()
            try:
                await self._pump
            except (asyncio.CancelledError, Exception):
                pass
            self._pump = None

    async def stop(self, frame: EndFrame):
        await super().stop(frame)
        await self._stop_pump()

    async def cancel(self, frame: CancelFrame):
        await super().cancel(frame)
        await self._stop_pump()


class _Output(BaseOutputTransport):
    def __init__(self, params: TransportParams, sidecar: SidecarClient, slot: int, call_id: str, latency: CallLatency):
        super().__init__(params)
        self._sidecar = sidecar
        self._slot = slot
        self._call_id = call_id
        self._latency = latency
        self._playhead = 0.0
        self._awaiting_first_audio = False
        self.audio_frames = 0

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, UserStoppedSpeakingFrame):
            self._latency.user_stopped()
            self._awaiting_first_audio = True
        elif isinstance(frame, InterruptionFrame):
            self._playhead = 0.0
            await self._sidecar.flush(self._call_id)
        elif isinstance(frame, MetricsFrame):
            self._latency.note_metrics(frame)
        await super().process_frame(frame, direction)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if self._awaiting_first_audio:
            self._awaiting_first_audio = False
            delta = self._latency.first_audio()
            if delta is not None:
                logger.info(f"[{self._call_id}] end-of-speech → first audio: {delta * 1000:.0f} ms")
        ok = await self._sidecar.send_audio(self._slot, frame.audio)
        if not ok:
            return False
        self.audio_frames += 1
        chunk_secs = len(frame.audio) / 2 / SAMPLE_RATE
        now = time.monotonic()
        if self._playhead < now:
            self._playhead = now
        self._playhead += chunk_secs
        ahead = self._playhead - now
        if ahead > LEAD_SECS:
            await asyncio.sleep(ahead - LEAD_SECS)
        return True


class WhatsAppCallTransport(BaseTransport):
    def __init__(self, sidecar: SidecarClient, slot: int, call_id: str, latency: CallLatency):
        super().__init__()
        self._params = WhatsAppCallParams(
            audio_in_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_in_channels=1,
            audio_out_enabled=True,
            audio_out_sample_rate=SAMPLE_RATE,
            audio_out_channels=1,
            audio_out_10ms_chunks=FRAME_MS // 10,
        )
        self._sidecar = sidecar
        self._slot = slot
        self._call_id = call_id
        self._input = _Input(self._params)
        self._output = _Output(self._params, sidecar, slot, call_id, latency)
        sidecar.bind_slot(slot, self._input)

    def input(self) -> _Input:
        return self._input

    def output(self) -> _Output:
        return self._output

    def release(self) -> None:
        self._sidecar.unbind_slot(self._slot)
