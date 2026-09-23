"""The call's brain: a live fork of the AL session, driven through the hub.

Replaces the Bedrock model + `delegate` tool (Yousef on the first live call:
"this delegate thing is just too many layers... make it closer to a normal
forked session where you have direct access to all the tools you need... tell
people to hold on while you do stuff"). Each user turn is one
`POST /voice/turn`; the hub streams the fork's text deltas back as NDJSON and
they go straight to the TTS. A `tool` event with nothing spoken yet in this
response speaks a filler in the conversation's language; a barge-in cancels the
stream and asks the hub to interrupt the fork, and the next utterance tells the
fork where it was cut off."""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Callable

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings

from .hub import HubClient
from .language import FILLERS

# Spoken when the fork's turn fails outright (hub down, fork ended, timeout).
APOLOGIES: dict[str, str] = {
    "en": "Sorry, I lost my train of thought. Say that again?",
    "ar": "معلش، ضيعت الفكرة. ممكن تقولها تاني؟",
    "de": "Entschuldigung, ich habe den Faden verloren. Sag das noch einmal?",
}

# A cue is pipeline-generated ("(The call was answered.)"), not the caller's words.
_CUE_RE = re.compile(r"^\(.*\)$", re.S)


def is_cue(text: str) -> bool:
    return bool(_CUE_RE.match(text.strip()))


class ForkLLMService(LLMService):
    def __init__(
        self,
        *,
        hub: HubClient,
        call_id: str,
        language: Callable[[], str],
        heard: Callable[[], str],
        on_turn_done: Callable[[dict], None] | None = None,
        on_turn_start: Callable[[], None] | None = None,
        **kwargs,
    ):
        super().__init__(
            settings=LLMSettings(
                model="al-fork", system_instruction=None, temperature=None, max_tokens=None, top_p=None, top_k=None,
                frequency_penalty=None, presence_penalty=None, seed=None, filter_incomplete_user_turns=None,
                user_turn_completion_config=None,
            ),
            **kwargs,
        )
        self._hub = hub
        self._call_id = call_id
        self._language = language
        self._heard = heard
        self._on_turn_done = on_turn_done
        self._on_turn_start = on_turn_start
        self._streaming = False
        self._chars_this_response = 0
        self._interrupted_after: str | None = None
        self.response_ended_at: float | None = None
        self.turns = 0
        self.tool_calls = 0
        self.errors = 0

    def can_generate_metrics(self) -> bool:
        return True

    @property
    def chars_this_response(self) -> int:
        return self._chars_this_response

    def _last_user_text(self, frame: LLMContextFrame) -> str | None:
        for msg in reversed(frame.context.get_messages()):
            if msg.get("role") != "user":
                continue
            content = msg.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
                return " ".join(parts)
            return None
        return None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            # Pipecat has already cancelled the streaming task by the time this
            # runs (see _run_turn's CancelledError path); this is the fallback
            # for a stream that was not cancelled. The frame must travel on: it
            # is what stops the TTS and flushes the sidecar's queued audio.
            if self._streaming:
                self._cut_off()
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMContextFrame):
            text = (self._last_user_text(frame) or "").strip()
            if not text:
                return
            await self._run_turn(text)
            return
        await self.push_frame(frame, direction)

    def _cut_off(self) -> None:
        """The caller talked over this response: remember how much of it they
        heard (for the next turn's "(you were interrupted after: …)") and stop
        the fork's turn hub-side."""
        if not self._streaming:
            return
        self._streaming = False
        self._interrupted_after = self._heard().strip() or None
        asyncio.create_task(self._hub.interrupt(self._call_id), name=f"interrupt-{self._call_id}")

    async def _run_turn(self, text: str) -> None:
        cue = is_cue(text)
        interrupted_after = None if cue else self._interrupted_after
        self._interrupted_after = None
        self._chars_this_response = 0
        self._streaming = True
        self.turns += 1
        if self._on_turn_start:
            self._on_turn_start()
        outcome: dict = {"type": "error", "message": "no result"}
        await self.push_frame(LLMFullResponseStartFrame())
        await self.start_processing_metrics()
        await self.start_ttfb_metrics()
        try:
            async for ev in self._hub.turn(self._call_id, text, cue=cue, interrupted_after=interrupted_after):
                kind = ev.get("type")
                if kind == "text":
                    chunk = str(ev.get("text") or "")
                    if not chunk:
                        continue
                    if self._chars_this_response == 0:
                        await self.stop_ttfb_metrics()
                    self._chars_this_response += len(chunk)
                    await self.push_frame(LLMTextFrame(chunk))
                elif kind == "tool":
                    self.tool_calls += 1
                    if self._chars_this_response == 0:
                        await self.stop_ttfb_metrics()
                        filler = _pick(FILLERS, self._language())
                        self._chars_this_response += len(filler)
                        await self.push_frame(TTSSpeakFrame(filler))
                elif kind in ("result", "error"):
                    outcome = ev
                    if kind == "error":
                        self.errors += 1
                        logger.warning(f"[{self._call_id}] fork turn error: {ev.get('message')}")
                        if self._streaming and self._chars_this_response == 0:
                            await self.push_frame(TTSSpeakFrame(_pick(APOLOGIES, self._language())))
                    break
        except asyncio.CancelledError:
            # A barge-in: the frame processor cancelled us mid-stream.
            self._cut_off()
            outcome = {"type": "result", "interrupted": True}
            raise
        except Exception as e:  # noqa: BLE001
            self.errors += 1
            outcome = {"type": "error", "message": repr(e)}
            logger.warning(f"[{self._call_id}] fork turn failed: {e!r}")
            if self._streaming and self._chars_this_response == 0:
                await self.push_frame(TTSSpeakFrame(_pick(APOLOGIES, self._language())))
        finally:
            self._streaming = False
            self.response_ended_at = time.monotonic()
            await self.stop_processing_metrics()
            await self.push_frame(LLMFullResponseEndFrame())
        if self._on_turn_done:
            try:
                self._on_turn_done({**outcome, "cue": cue, "text": text, "spokenChars": self._chars_this_response})
            except Exception:  # noqa: BLE001
                logger.exception("on_turn_done failed")


def _pick(table: dict[str, str] | dict[str, list[str]], lang: str) -> str:
    import random

    v = table.get(lang) or table.get("en")
    if isinstance(v, list):
        return random.choice(v)
    return str(v)
