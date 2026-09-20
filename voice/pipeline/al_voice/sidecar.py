"""Client for the wa-voice control socket.

One persistent WebSocket. Text frames are JSON events/commands; binary frames
are `[slot][s16le 16 kHz PCM]`. Audio for a slot is routed to whichever
`AudioSink` registered for it; everything else is fanned out to the event
handler. Reconnects with backoff — the sidecar may restart independently."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import websockets
from loguru import logger


class AudioSink(Protocol):
    def on_audio(self, pcm: bytes) -> None: ...


EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


class SidecarClient:
    def __init__(self, url: str, on_event: EventHandler):
        self._url = url
        self._on_event = on_event
        self._ws: websockets.ClientConnection | None = None
        self._sinks: dict[int, AudioSink] = {}
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._task: asyncio.Task | None = None
        self._connected = asyncio.Event()
        self.state: dict[str, Any] = {"connected": False, "paired": False, "jid": None}

    # ---- lifecycle ----

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="sidecar-client")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._ws:
            await self._ws.close()

    @property
    def connected(self) -> bool:
        return self._ws is not None and self._connected.is_set()

    async def wait_connected(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(self._url, max_size=None, ping_interval=20) as ws:
                    self._ws = ws
                    self._connected.set()
                    backoff = 1.0
                    logger.info(f"sidecar connected at {self._url}")
                    async for msg in ws:
                        if isinstance(msg, bytes):
                            if msg and (sink := self._sinks.get(msg[0])):
                                sink.on_audio(msg[1:])
                            continue
                        try:
                            ev = json.loads(msg)
                        except json.JSONDecodeError:
                            logger.warning(f"sidecar sent non-JSON text: {msg[:80]!r}")
                            continue
                        await self._dispatch(ev)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — reconnect on anything
                logger.warning(f"sidecar connection lost ({e!r}); retrying in {backoff:.0f}s")
            finally:
                self._ws = None
                self._connected.clear()
                self.state["connected"] = False
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(ConnectionError("sidecar disconnected"))
                self._pending.clear()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _dispatch(self, ev: dict[str, Any]) -> None:
        kind = ev.get("ev")
        if kind == "status":
            self.state.update(connected=ev.get("connected"), paired=ev.get("paired"), jid=ev.get("jid"))
        elif kind == "ready":
            self.state.update(connected=True, paired=True, jid=ev.get("jid"))
        elif kind in ("disconnected", "loggedout"):
            self.state["connected"] = False
            if kind == "loggedout":
                self.state["paired"] = False
        elif kind == "qr":
            self.state["paired"] = False
        rid = ev.get("id")
        if rid and (fut := self._pending.pop(rid, None)) and not fut.done():
            fut.set_result(ev)
        if kind in ("pong",):
            return
        try:
            await self._on_event(ev)
        except Exception:  # noqa: BLE001
            logger.exception(f"event handler failed for {kind}")

    # ---- audio ----

    def bind_slot(self, slot: int, sink: AudioSink) -> None:
        self._sinks[slot] = sink

    def unbind_slot(self, slot: int) -> None:
        self._sinks.pop(slot, None)

    async def send_audio(self, slot: int, pcm: bytes) -> bool:
        ws = self._ws
        if ws is None:
            return False
        try:
            await ws.send(bytes((slot,)) + pcm)
            return True
        except Exception:  # noqa: BLE001
            return False

    # ---- commands ----

    async def _send(self, obj: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            raise ConnectionError("sidecar not connected")
        await ws.send(json.dumps(obj))

    async def command(self, cmd: str, timeout: float = 20.0, **fields: Any) -> dict[str, Any]:
        """Send a command and wait for its ack/error (correlated by `id`)."""
        rid = uuid.uuid4().hex[:8]
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._send({"cmd": cmd, "id": rid, **fields})
        try:
            reply = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)
        if reply.get("ev") == "error":
            raise RuntimeError(reply.get("message") or "sidecar error")
        return reply

    async def call(self, to: str) -> dict[str, Any]:
        return await self.command("call", to=to, timeout=30.0)

    async def answer(self, call_id: str) -> dict[str, Any]:
        return await self.command("answer", callId=call_id, timeout=30.0)

    async def reject(self, call_id: str) -> None:
        try:
            await self.command("reject", callId=call_id)
        except RuntimeError as e:
            logger.warning(f"reject {call_id}: {e}")

    async def hangup(self, call_id: str) -> None:
        try:
            await self.command("hangup", callId=call_id)
        except (RuntimeError, ConnectionError) as e:
            logger.warning(f"hangup {call_id}: {e}")

    async def flush(self, call_id: str) -> None:
        try:
            await self._send({"cmd": "flush", "callId": call_id})
        except ConnectionError:
            pass

    async def status(self) -> dict[str, Any]:
        return await self.command("status", timeout=5.0)
