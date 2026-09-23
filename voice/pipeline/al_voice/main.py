"""al-voice-pipeline: the process pm2 runs.

- Holds the sidecar socket; every `incoming` asks the hub whether to answer
  (`POST /voice/session`, which also forks AL for the call).
- FastAPI on 127.0.0.1:9879 for the hub: `POST /call {jid, task}`, `GET /health`,
  `GET /calls`, `POST /hangup/{callId}` (graceful: after the current sentence).
- On `ended` posts the transcript back to the hub, whatever the outcome."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pydantic import BaseModel

from .call import CallSession
from .clips import CARTESIA_VERSION, ClipStore
from .config import Config
from .hub import HubClient
from .language import voice_languages
from .sidecar import SidecarClient


def signal_frames(pcm: bytes, floor_dbfs: float = -50.0) -> int:
    """How many 60 ms frames of this clip carry signal (RMS above the idle
    floor) — the sidecar judges its ticks by the same rule."""
    import numpy as np

    n = 0
    for i in range(0, len(pcm), 1920):
        chunk = np.frombuffer(pcm[i : i + 1920].ljust(1920, b"\0"), dtype="<i2").astype(np.float32)
        rms = float(np.sqrt(np.mean(chunk * chunk))) if chunk.size else 0.0
        if rms > 0 and 20 * np.log10(rms / 32767.0) > floor_dbfs:
            n += 1
    return n


def loopback_verdict(rep: dict[str, Any], pcm: bytes) -> tuple[bool, str | None]:
    """Did the clip go through the sidecar's clock + encoder as a call would
    send it? Every clip frame that carries signal must have come out of the
    mic clock as signal (a spoken clip has quiet edges and pauses — those are
    not missing frames), every tick's frame must have become a packet, and
    encoding must be real-time. Packet SIZE is not judged: MLow is
    content-adaptive (a pure tone codes smaller than the -60 dBFS floor)."""
    expected = signal_frames(pcm)
    frames = int(rep.get("frames") or 0)
    speech = int(rep.get("speechFrames") or 0)
    encoded = int(rep.get("encodedFrames") or 0)
    encode_ms_max = float(rep.get("encodeMsMax") or 0)
    if expected == 0:
        return False, "the probe clip itself is silent"
    if speech < expected - 1:
        return False, f"only {speech} of the clip's {expected} signal frames came out of the mic clock"
    if frames == 0 or encoded < frames:
        return False, f"encoder produced packets for {encoded} of {frames} frames"
    if encode_ms_max >= 60:
        return False, f"encoder too slow for real time ({encode_ms_max:.0f} ms for one 60 ms frame)"
    return True, None


class CallManager:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.hub = HubClient(cfg)
        self.sidecar = SidecarClient(cfg.sidecar_url, self._on_sidecar_event)
        self.clips = ClipStore(cfg)
        self.calls: dict[str, CallSession] = {}
        self.recent: list[dict[str, Any]] = []
        self.tts_languages: tuple[str, ...] = cfg.tts_languages
        self._cartesia_probe: dict[str, Any] = {}
        self._loopback_probe: dict[str, Any] = {}

    async def start(self) -> None:
        self.sidecar.start()
        langs = await voice_languages(self.cfg)
        if langs:
            self.tts_languages = langs
        logger.info(f"tts languages: {', '.join(self.tts_languages)}")
        asyncio.create_task(self._warm(), name="warm")

    async def _warm(self) -> None:
        """First-call costs, paid at boot: the Silero ONNX session (26 s on a
        cold, saturated disk in call 008048b0) and the apology/hold-on clips."""
        t0 = time.monotonic()
        try:
            await asyncio.to_thread(SileroVADAnalyzer, sample_rate=16000)
            logger.info(f"silero vad warm in {time.monotonic() - t0:.1f} s")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"silero warm-up failed: {e!r}")
        await self.clips.ensure(self.tts_languages)

    async def cartesia_health(self) -> dict[str, Any]:
        """Is Cartesia reachable right now? A GET of the voice record over the
        same API the TTS/STT sockets hang off; cached 15 s."""
        now = time.monotonic()
        cached = self._cartesia_probe
        if cached and now - cached.get("_at", 0) < 15:
            return {k: v for k, v in cached.items() if not k.startswith("_")}
        cfg = self.cfg
        out: dict[str, Any] = {"ok": False, "ms": None, "error": None}
        if not cfg.cartesia_api_key or not cfg.cartesia_voice_id:
            out["error"] = "not configured"
        else:
            t0 = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=4.0) as http:
                    r = await http.get(
                        f"https://api.cartesia.ai/voices/{cfg.cartesia_voice_id}",
                        headers={"X-API-Key": cfg.cartesia_api_key, "Cartesia-Version": CARTESIA_VERSION},
                    )
                out["ms"] = int((time.monotonic() - t0) * 1000)
                out["ok"] = r.status_code == 200
                if r.status_code != 200:
                    out["error"] = f"HTTP {r.status_code}"
            except Exception as e:  # noqa: BLE001
                out["ms"] = int((time.monotonic() - t0) * 1000)
                out["error"] = repr(e)
        self._cartesia_probe = {**out, "_at": now}
        return out

    async def loopback_health(self, fresh: bool = False) -> dict[str, Any]:
        """The pre-call audio loopback: the hold-on clip (Yousef's clone, the
        very PCM a call would send) through the sidecar socket, its mic clock
        and the MLow encoder, packet sizes back. Everything short of the
        network. Cached 60 s unless `fresh`."""
        now = time.monotonic()
        cached = self._loopback_probe
        if not fresh and cached and now - cached.get("_at", 0) < 60:
            return {k: v for k, v in cached.items() if not k.startswith("_")}
        out: dict[str, Any] = {"ok": False, "ms": None, "error": None}
        clip = self.clips.get("hold_on", "en")
        if clip is None:
            out["error"] = "no hold_on.en clip to send"
        elif not self.sidecar.connected:
            out["error"] = "sidecar socket down"
        else:
            t0 = time.monotonic()
            try:
                rep = await self.sidecar.loopback(clip[1])
                out["ms"] = int((time.monotonic() - t0) * 1000)
                out.update({k: rep.get(k) for k in ("frames", "speechFrames", "encodedFrames", "meanSpeechPacket", "meanIdlePacket", "encodeMsMax", "inputDbfs")})
                out["ok"], out["error"] = loopback_verdict(rep, clip[1])
            except Exception as e:  # noqa: BLE001
                out["ms"] = int((time.monotonic() - t0) * 1000)
                out["error"] = f"loopback command: {e!r}"
        self._loopback_probe = {**out, "_at": now}
        if not out["ok"]:
            logger.warning(f"audio loopback FAILED: {out}")
        return out

    async def sidecar_health(self) -> dict[str, Any]:
        """The control socket, round-tripped: a `status` command answered
        within 3 s. `connected` alone is what the socket LOOKS like; the
        22:29–22:37 flaps on 23 Sept were live sockets that had stopped
        answering."""
        if not self.sidecar.connected:
            return {"socket": False, "rtt_ms": None, **self.sidecar.state}
        t0 = time.monotonic()
        try:
            await self.sidecar.command("status", timeout=3.0)
            return {"socket": True, "rtt_ms": int((time.monotonic() - t0) * 1000), **self.sidecar.state}
        except Exception as e:  # noqa: BLE001
            return {"socket": True, "rtt_ms": None, "error": f"status command: {e!r}", **self.sidecar.state}

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
        if not await self.hub.health():
            raise HTTPException(503, "hub unreachable — the call's AL fork cannot be started")
        loop = await self.loopback_health(fresh=True)
        if not loop.get("ok"):
            raise HTTPException(503, f"pre-call audio loopback failed: {loop.get('error')} — not dialling into a call nobody would hear")
        # Dial first: the sidecar mints the call id. The fork + pipeline then
        # warm up during the ring (typically 5-10 s).
        ack = await self.sidecar.call(jid)
        call_id = ack.get("callId")
        slot = ack.get("slot")
        if not call_id or slot is None:
            raise HTTPException(502, f"sidecar did not return a call id: {ack}")
        try:
            sess = await self.hub.session(call_id, jid, "out", task=task)
        except Exception as e:  # noqa: BLE001
            logger.error(f"[{call_id}] hub session failed: {e!r}; cancelling the call")
            await self.sidecar.hangup(call_id)
            raise HTTPException(502, f"hub refused to start the call's AL fork: {e}")
        if not sess.get("answer", True):
            await self.sidecar.hangup(call_id)
            raise HTTPException(403, sess.get("why") or "hub refused the call")
        session = CallSession(
            cfg=self.cfg, sidecar=self.sidecar, hub=self.hub, call_id=call_id, slot=int(slot),
            jid=jid, direction="out", session=sess, task=task, tts_languages=self.tts_languages, clips=self.clips,
        )
        self.calls[call_id] = session
        logger.info(f"[{call_id}] ringing {session.display_name}; fork {sess.get('forkKey')} warming")
        asyncio.create_task(self._prepare(session), name=f"prepare-{call_id}")
        return {"ok": True, "callId": call_id, "slot": slot, "to": jid, "displayName": session.display_name, "forkSessionId": sess.get("forkSessionId")}

    async def _prepare(self, session: CallSession) -> None:
        try:
            await session.prepare()
        except Exception as e:  # noqa: BLE001
            session.fail(f"pipeline could not be built: {e!r}")

    # ---- sidecar events ----

    async def _on_sidecar_event(self, ev: dict[str, Any]) -> None:
        kind = ev.get("ev")
        if kind == "incoming":
            await self._on_incoming(ev)
        elif kind == "accepted":
            call = self.calls.get(ev.get("callId", ""))
            if call and call.live_at is None:
                warm = f"{time.time() - call.prepared_at:.1f} s after prepare" if call.prepared_at else "pipeline not yet prepared"
                state = "ready" if call.ready.is_set() else ("FAILED" if call.failed else "NOT READY")
                logger.info(f"[{call.call_id}] accepted — live ({warm}; pipeline {state})")
                await call.go()
        elif kind == "ended":
            await self._on_ended(ev)
        elif kind == "health":
            call = self.calls.get(ev.get("callId", ""))
            if call:
                await call.notify_line_problem(ev.get("kind") or "line", ev.get("issue") or "the line is degraded")
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
        loop = await self.loopback_health(fresh=True)
        if not loop.get("ok"):
            logger.error(f"[{call_id}] pre-call audio loopback failed ({loop.get('error')}) — rejecting {jid} rather than answering into silence")
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "failed", f"PIPELINE SETUP FAILED: pre-call audio loopback: {loop.get('error')}")
            return
        try:
            sess = await self.hub.session(call_id, jid, "in")
        except Exception as e:  # noqa: BLE001
            logger.error(f"[{call_id}] hub session failed: {e!r}; rejecting")
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "failed", f"hub session: {e}")
            return
        if not sess.get("answer"):
            logger.info(f"[{call_id}] policy says no ({sess.get('why')}) — rejecting {jid}")
            await self.sidecar.reject(call_id)
            await self._report_unanswered(call_id, jid, "rejected", sess.get("why") or "policy", sess)
            return
        session = CallSession(
            cfg=self.cfg, sidecar=self.sidecar, hub=self.hub, call_id=call_id, slot=slot,
            jid=jid, direction="in", session=sess, tts_languages=self.tts_languages, clips=self.clips,
        )
        self.calls[call_id] = session
        # Sockets open while we answer; the caller's first words meet a live pipeline.
        prep = asyncio.create_task(self._prepare(session), name=f"prepare-{call_id}")
        try:
            await self.sidecar.answer(call_id)
        except Exception as e:  # noqa: BLE001
            logger.error(f"[{call_id}] answer failed: {e!r}")
            prep.cancel()
            self.calls.pop(call_id, None)
            await session.stop("answer failed")
            await self._report_unanswered(call_id, jid, "failed", str(e), sess)

    async def _on_ended(self, ev: dict[str, Any]) -> None:
        call_id = ev.get("callId", "")
        reason = ev.get("reason")
        call = self.calls.pop(call_id, None)
        if not call:
            return
        if call.live_at is None and not call.failed:
            call.outcome = {"declined": "declined", "timeout": "no-answer", "cancelled": "missed"}.get(reason or "", "no-answer")
        await call.stop(reason)
        payload = call.transcript_payload()
        self._remember(payload)
        logger.info(
            f"[{call_id}] ended ({reason}); outcome {payload['outcome']}"
            f"{' — ' + payload['reason'] if call.failed else ''}; {len(payload['turns'])} turns, "
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
            "ttsLanguages": list(self.tts_languages),
            "active": [
                {"callId": c.call_id, "jid": c.jid, "displayName": c.display_name, "direction": c.direction,
                 "live": c.live_at is not None, "prepared": c.prepared_at is not None, "ready": c.ready.is_set(), "failed": c.failed,
                 "forkSessionId": c.fork_session_id, "turns": len(c._collector.turns) if c._collector else 0,
                 "lastTurn": (c._collector.turns[-1] if c._collector and c._collector.turns else None)}
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
        # Everything a call needs, each actually exercised: the hub, the
        # sidecar socket round-tripped, Cartesia reachable, the fallback clips
        # on disk. `ok` is the AND — `con whatsapp voice` said all green at
        # 23:22 on 23 Sept while Cartesia was never probed.
        hub_ok, sidecar, cartesia, loopback = await asyncio.gather(
            manager.hub.health(), manager.sidecar_health(), manager.cartesia_health(), manager.loopback_health()
        )
        clips = manager.clips.status(manager.tts_languages)
        missing = cfg.missing()
        ok = bool(hub_ok and sidecar.get("socket") and sidecar.get("rtt_ms") is not None and sidecar.get("connected") and cartesia.get("ok") and loopback.get("ok") and not missing)
        return {"ok": ok, "hub": hub_ok, **sidecar, "cartesia": cartesia, "loopback": loopback, "clips": clips, "missing": missing}

    @app.get("/calls")
    async def calls():
        return manager.snapshot()

    @app.post("/call")
    async def call(req: CallRequest):
        return await manager.place_call(req.jid.strip(), req.task.strip())

    @app.post("/hangup/{call_id}")
    async def hangup(call_id: str, now: bool = False):
        call = manager.calls.get(call_id)
        if not call:
            raise HTTPException(404, "no such call")
        if now or call.live_at is None:
            await manager.sidecar.hangup(call_id)
        else:
            call.request_hangup("api")
        return {"ok": True, "graceful": not now and call.live_at is not None}

    return app


def cli() -> None:
    logger.remove()
    logger.add(sys.stderr, level="INFO", format="[al-voice] {time:HH:mm:ss.SSS} {level:<7} {message}")
    cfg = Config.load()
    app = build_app(cfg)
    uvicorn.run(app, host=cfg.listen_host, port=cfg.listen_port, log_level="warning", access_log=False)


if __name__ == "__main__":
    cli()
