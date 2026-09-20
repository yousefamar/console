"""al-voice-pipeline: the process pm2 runs.

- Holds the sidecar socket; every `incoming` asks the hub whether to answer.
- FastAPI on 127.0.0.1:9879 for the hub: `POST /call {jid, task}`, `GET /health`,
  `GET /calls`.
- On `ended` posts the transcript back to the hub, whatever the outcome."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from loguru import logger
from pydantic import BaseModel

from .call import CallSession
from .config import Config
from .hub import HubClient
from .sidecar import SidecarClient


class CallManager:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.hub = HubClient(cfg)
        self.sidecar = SidecarClient(cfg.sidecar_url, self._on_sidecar_event)
        self.calls: dict[str, CallSession] = {}
        self._pending_outbound: dict[str, dict[str, Any]] = {}
        self.recent: list[dict[str, Any]] = []

    async def start(self) -> None:
        self.sidecar.start()

    async def stop(self) -> None:
        for call in list(self.calls.values()):
            await self.sidecar.hangup(call.call_id)
            await call.stop("shutdown")
        await self.sidecar.stop()
        await self.hub.close()

    # ---- outbound ----

    async def place_call(self, jid: str, task: str) -> dict[str, Any]:
        if not self.sidecar.connected or not self.sidecar.state.get("connected"):
            raise HTTPException(503, "WhatsApp voice device is not connected (sidecar down or unpaired)")
        if self.calls:
            raise HTTPException(409, "a call is already in progress")
        ctx = await self.hub.context(jid, task=task, direction="out")
        if not ctx.get("answer", True):
            raise HTTPException(403, ctx.get("why") or "hub refused the call")
        ack = await self.sidecar.call(jid)
        call_id = ack.get("callId")
        slot = ack.get("slot")
        if not call_id or slot is None:
            raise HTTPException(502, f"sidecar did not return a call id: {ack}")
        session = CallSession(
            cfg=self.cfg, sidecar=self.sidecar, hub=self.hub, call_id=call_id, slot=int(slot),
            jid=jid, direction="out", context=ctx, task=task,
        )
        self.calls[call_id] = session
        logger.info(f"[{call_id}] ringing {ctx.get('displayName') or jid}")
        return {"ok": True, "callId": call_id, "slot": slot, "to": jid, "displayName": ctx.get("displayName")}

    # ---- sidecar events ----

    async def _on_sidecar_event(self, ev: dict[str, Any]) -> None:
        kind = ev.get("ev")
        if kind == "incoming":
            await self._on_incoming(ev)
        elif kind == "accepted":
            call = self.calls.get(ev.get("callId", ""))
            if call and call.live_at is None:
                logger.info(f"[{call.call_id}] accepted — starting pipeline")
                await call.start()
        elif kind == "ended":
            await self._on_ended(ev)
        elif kind == "error" and ev.get("callId") in self.calls:
            logger.warning(f"[{ev.get('callId')}] sidecar error: {ev.get('message')}")
        elif kind in ("ready", "disconnected", "loggedout", "qr"):
            logger.info(f"sidecar: {kind} {json.dumps({k: v for k, v in ev.items() if k not in ('ev', 'dataUrl', 'code')})}")

    async def _on_incoming(self, ev: dict[str, Any]) -> None:
        call_id = ev["callId"]
        jid = ev.get("from", "")
        slot = int(ev.get("slot", 0))
        if ev.get("video"):
            logger.info(f"[{call_id}] rejecting video call from {jid}")
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "rejected", "video call")
            return
        if not self.cfg.inbound_enabled:
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "rejected", "inbound disabled")
            return
        if self.calls:
            logger.info(f"[{call_id}] busy — rejecting {jid}")
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "missed", "busy")
            return
        try:
            ctx = await self.hub.context(jid, direction="in")
        except Exception as e:  # noqa: BLE001
            logger.error(f"[{call_id}] hub context failed: {e!r}; rejecting")
            await self.sidecar.reject(call_id)
            return
        if not ctx.get("answer"):
            logger.info(f"[{call_id}] policy says no ({ctx.get('why')}) — rejecting {jid}")
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "rejected", ctx.get("why") or "policy", ctx)
            return
        session = CallSession(
            cfg=self.cfg, sidecar=self.sidecar, hub=self.hub, call_id=call_id, slot=slot,
            jid=jid, direction="in", context=ctx,
        )
        self.calls[call_id] = session
        try:
            await self.sidecar.answer(call_id)
        except Exception as e:  # noqa: BLE001
            logger.error(f"[{call_id}] answer failed: {e!r}")
            self.calls.pop(call_id, None)
            await self._report_unanswered(call_id, jid, "failed", str(e), ctx)

    async def _on_ended(self, ev: dict[str, Any]) -> None:
        call_id = ev.get("callId", "")
        reason = ev.get("reason")
        call = self.calls.pop(call_id, None)
        if not call:
            return
        if call.live_at is None:
            call.outcome = {"declined": "declined", "timeout": "no-answer", "cancelled": "missed"}.get(reason or "", "no-answer")
        await call.stop(reason)
        payload = call.transcript_payload()
        self._remember(payload)
        logger.info(
            f"[{call_id}] ended ({reason}); {len(payload['turns'])} turns, "
            f"{payload['durationMs'] / 1000:.0f}s, latency {json.dumps(payload['latency'].get('eos_to_first_audio'))}"
        )
        try:
            await self.hub.transcript(payload)
        except Exception:  # noqa: BLE001
            self._spool(payload)

    async def _report_unanswered(self, call_id: str, jid: str, outcome: str, reason: str, ctx: dict[str, Any] | None = None) -> None:
        payload = {
            "callId": call_id, "jid": jid, "user": (ctx or {}).get("user"), "displayName": (ctx or {}).get("displayName") or jid,
            "direction": "in", "outcome": outcome, "reason": reason, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "answeredAt": None, "durationMs": 0, "turns": [], "delegations": 0, "latency": {}, "models": {},
        }
        self._remember(payload)
        try:
            await self.hub.transcript(payload)
        except Exception:  # noqa: BLE001
            self._spool(payload)

    def _remember(self, payload: dict[str, Any]) -> None:
        self.recent.append(payload)
        del self.recent[:-50]
        try:
            (self.cfg.log_dir / f"{payload['callId']}.json").write_text(json.dumps(payload, indent=2))
        except OSError as e:
            logger.warning(f"could not write call log: {e}")

    def _spool(self, payload: dict[str, Any]) -> None:
        # The hub was unreachable; keep the file so it can be replayed by hand.
        p = self.cfg.log_dir / f"{payload['callId']}.unsent.json"
        try:
            p.write_text(json.dumps(payload, indent=2))
            logger.warning(f"transcript spooled to {p}")
        except OSError as e:
            logger.error(f"could not spool transcript: {e}")

    def snapshot(self) -> dict[str, Any]:
        return {
            "sidecar": {"socket": self.sidecar.connected, **self.sidecar.state},
            "active": [
                {"callId": c.call_id, "jid": c.jid, "direction": c.direction, "live": c.live_at is not None,
                 "turns": len(c._collector.turns) if c._collector else 0}
                for c in self.calls.values()
            ],
            "recent": [
                {k: p.get(k) for k in ("callId", "jid", "displayName", "direction", "outcome", "durationMs", "startedAt")}
                for p in self.recent[-10:]
            ],
        }


class CallRequest(BaseModel):
    jid: str
    task: str


def build_app(cfg: Config) -> FastAPI:
    manager = CallManager(cfg)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        missing = cfg.missing()
        if missing:
            logger.error(f"missing configuration: {', '.join(missing)} — calls will fail until fixed")
        await manager.start()
        logger.info(f"al-voice-pipeline listening on http://{cfg.listen_host}:{cfg.listen_port}; sidecar {cfg.sidecar_url}")
        try:
            yield
        finally:
            await manager.stop()

    app = FastAPI(title="al-voice-pipeline", lifespan=lifespan)
    app.state.manager = manager

    @app.get("/health")
    async def health():
        return {"ok": True, "hub": await manager.hub.health(), **manager.snapshot()["sidecar"], "missing": cfg.missing()}

    @app.get("/calls")
    async def calls():
        return manager.snapshot()

    @app.post("/call")
    async def call(req: CallRequest):
        return await manager.place_call(req.jid.strip(), req.task.strip())

    @app.post("/hangup/{call_id}")
    async def hangup(call_id: str):
        if call_id not in manager.calls:
            raise HTTPException(404, "no such call")
        await manager.sidecar.hangup(call_id)
        return {"ok": True}

    return app


def cli() -> None:
    logger.remove()
    logger.add(sys.stderr, level="INFO", format="[al-voice] {time:HH:mm:ss.SSS} {level:<7} {message}")
    cfg = Config.load()
    app = build_app(cfg)
    uvicorn.run(app, host=cfg.listen_host, port=cfg.listen_port, log_level="warning", access_log=False)


if __name__ == "__main__":
    cli()
