"""End-to-end harness without WhatsApp or the hub: a fake wa-voice socket + a
fake hub whose "AL fork" is scripted.

    uv run python tests/harness.py --wavs tests/q1.wav tests/q2.wav tests/q3.wav [--inbound]
    uv run python tests/make_wavs.py      # synthesises the q*.wav prompts with the clone

Starts (1) a fake sidecar on ws://127.0.0.1:9978 that speaks the real
protocol, rings for --ring seconds, streams each --wavs file (16 kHz mono s16)
into the call at real time once the bot goes quiet, and records what the bot
says to `tests/out-*.wav`; (2) a fake hub on http://127.0.0.1:9977 serving
/voice/session, /voice/turn (NDJSON, scripted replies incl. a tool event and
Arabic), /voice/interrupt and /voice/transcript. Then it launches the real
pipeline process pointed at both and places (or receives) one call. Prints the
transcript payload, the turn requests the fake fork saw, and the checks:
exactly one greeting, first audio soon after accept, a hangup after the caller
asks for one."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import httpx
import websockets
from aiohttp import web

HERE = Path(__file__).parent
FRAME = 960 * 2  # bytes per 60 ms


def read_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16 kHz mono s16"
        return w.readframes(w.getnframes())


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)


class FakeSidecar:
    def __init__(self, wavs: list[bytes], inbound: bool, ring_secs: float, barge: bool = False):
        self.wavs = wavs
        self.inbound = inbound
        self.ring_secs = ring_secs
        self.barge = barge
        self.ws = None
        self.out = bytearray()
        self.call_id = "TESTCALL1"
        self.last_bot_audio = 0.0
        self.first_bot_audio: float | None = None
        self.accepted_at: float | None = None
        self.bot_spoke = asyncio.Event()
        self.ended = asyncio.Event()
        self.answered = asyncio.Event()
        self.hangup_at: float | None = None
        self.flushes = 0
        self.reply_latencies: list[float] = []

    async def send(self, obj):
        await self.ws.send(json.dumps(obj))

    async def handler(self, ws):
        self.ws = ws
        await self.send({"ev": "status", "connected": True, "paired": True, "jid": "447897073727@s.whatsapp.net", "calls": []})
        await self.send({"ev": "ready", "jid": "447897073727@s.whatsapp.net"})
        if self.inbound:
            asyncio.get_running_loop().call_later(0.5, lambda: asyncio.ensure_future(
                self.send({"ev": "incoming", "callId": self.call_id, "from": "447845443890@s.whatsapp.net", "video": False, "slot": 0})))
        async for msg in ws:
            if isinstance(msg, bytes):
                if msg and msg[0] == 0:
                    self.out.extend(msg[1:])
                    self.last_bot_audio = time.monotonic()
                    if getattr(self, "speech_end_at", None) and getattr(self, "reply_latency", None) is None:
                        self.reply_latency = self.last_bot_audio - self.speech_end_at
                        self.reply_latencies.append(self.reply_latency)
                    if self.first_bot_audio is None:
                        self.first_bot_audio = self.last_bot_audio
                    self.bot_spoke.set()
                continue
            cmd = json.loads(msg)
            c = cmd.get("cmd")
            if c == "call":
                await self.send({"ev": "ack", "cmd": "call", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "ringing", "callId": self.call_id, "slot": 0})
                asyncio.ensure_future(self._accept_later())
            elif c == "answer":
                await self.send({"ev": "ack", "cmd": "answer", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "accepted", "callId": self.call_id, "slot": 0})
                self.accepted_at = time.monotonic()
                self.answered.set()
            elif c == "reject":
                await self.send({"ev": "ack", "cmd": "reject", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "rejected", "durationMs": 0})
                self.ended.set()
            elif c == "hangup":
                self.hangup_at = time.monotonic()
                print(f"[harness] hangup received {self.hangup_at - self.last_bot_audio:.2f}s after the last bot audio")
                await self.send({"ev": "ack", "cmd": "hangup", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "local", "durationMs": 1000})
                self.ended.set()
            elif c == "flush":
                self.flushes += 1
                print("[harness] flush (barge-in) received")
            elif c == "status":
                await self.send({"ev": "status", "connected": True, "paired": True, "jid": "x", "calls": [], "id": cmd.get("id")})
            elif c == "loopback":
                # What the real sidecar reports for a clip that codes as speech.
                import base64
                n = -(-len(base64.b64decode(cmd["pcm"])) // 1920)
                await self.send({"ev": "loopback", "frames": n + 12, "speechFrames": n, "encodedFrames": n + 12, "encodedBytes": n * 160 + 12 * 80,
                                 "meanSpeechPacket": 160.0, "meanIdlePacket": 80.0, "encodeMsMax": 0.9, "inputDbfs": -22.0, "id": cmd.get("id")})

    async def _accept_later(self):
        await asyncio.sleep(self.ring_secs)
        await self.send({"ev": "accepted", "callId": self.call_id, "slot": 0})
        self.accepted_at = time.monotonic()
        self.answered.set()

    async def stream_wav(self, wav: bytes):
        t0 = time.monotonic()
        for i in range(0, len(wav), FRAME):
            chunk = wav[i:i + FRAME]
            if len(chunk) < FRAME:
                chunk = chunk + b"\0" * (FRAME - len(chunk))
            await self.ws.send(bytes((0,)) + chunk)
            await asyncio.sleep(max(0, t0 + (i // FRAME + 1) * 0.06 - time.monotonic()))
        # end of the caller's speech (the wav has ~0.3 s of Cartesia tail silence)
        self.speech_end_at = time.monotonic()
        self.reply_latency = None
        for _ in range(20):
            await self.ws.send(bytes((0,)) + b"\0" * FRAME)
            await asyncio.sleep(0.06)

    async def drive(self):
        await self.answered.wait()
        await asyncio.sleep(0.3)
        if not self.wavs:
            # A silent caller (the --setup-fail run): the bot must end the call.
            deadline = time.monotonic() + 40
            while not self.ended.is_set() and time.monotonic() < deadline:
                await self.ws.send(bytes((0,)) + b"\0" * FRAME)
                await asyncio.sleep(0.06)
            if not self.ended.is_set():
                print("[harness] the pipeline never hung up — ending from the peer side")
                await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "peer", "durationMs": 40_000})
                self.ended.set()
            return
        for i, wav in enumerate(list(self.wavs)):
            if wav is None:
                continue
            if i == 0 and not self.inbound:
                await self.wait_quiet(first=True)
            if self.ended.is_set():
                return
            print(f"[harness] speaking turn {i + 1}")
            await self.stream_wav(wav)
            if self.barge and i == 0:
                # talk over the story 1.5 s into it
                self.bot_spoke.clear()
                while not self.bot_spoke.is_set() and not self.ended.is_set():
                    await self.ws.send(bytes((0,)) + b"\0" * FRAME)
                    await asyncio.sleep(0.06)
                t0 = time.monotonic()
                while time.monotonic() - t0 < 1.5:
                    await self.ws.send(bytes((0,)) + b"\0" * FRAME)
                    await asyncio.sleep(0.06)
                print("[harness] barging in")
                self.barge_at = time.monotonic()
                await self.stream_wav(self.wavs[1])
                self.wavs = [self.wavs[0], None, *self.wavs[2:]]
            await self.wait_quiet()
        # give a graceful hangup a chance before we end from the peer side
        for _ in range(60):
            if self.ended.is_set():
                return
            await self.ws.send(bytes((0,)) + b"\0" * FRAME)
            await asyncio.sleep(0.06)
        await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "peer", "durationMs": 10_000})
        self.ended.set()

    async def wait_quiet(self, first=False):
        """Feed silence until the bot has spoken and then been quiet for 1.2 s."""
        self.bot_spoke.clear()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not self.ended.is_set():
            await self.ws.send(bytes((0,)) + b"\0" * FRAME)
            await asyncio.sleep(0.06)
            if self.bot_spoke.is_set() and time.monotonic() - self.last_bot_audio > 1.2:
                return
        if not self.ended.is_set():
            print("[harness] bot never spoke (timeout)")


class FakeHub:
    """Scripted AL fork. Replies depend on what was said; a hang-up request is
    answered with a goodbye but NO hangup command (the pipeline's safety net
    must end the call)."""

    def __init__(self):
        self.transcript = asyncio.Future()
        self.turn_requests: list[dict] = []
        self.interrupts = 0
        self.interrupted = asyncio.Event()
        self.app = web.Application()
        self.app.add_routes([
            web.post("/voice/session", self.session),
            web.post("/voice/turn", self.turn),
            web.post("/voice/interrupt", self.interrupt),
            web.post("/voice/transcript", self.transcript_post),
            web.get("/voice/health", lambda r: web.json_response({"ok": True})),
        ])

    async def session(self, req):
        body = await req.json()
        print(f"[fake-hub] session: {json.dumps(body)}")
        self.greeting = "Hi Yousef, it's AL. This is a harness test call. Can you hear me alright?" if body.get("direction") == "out" else None
        return web.json_response({"answer": True, "why": "owner", "displayName": "Yousef", "user": "yousef", "jid": body.get("jid"),
                                  "forkSessionId": "fake-fork", "forkKey": "al-call-testcall-fork", "model": None, "contextMode": "fresh"})

    def script(self, text: str, cue: bool) -> list[tuple[str, float] | tuple[str, str]]:
        """[(kind, payload)] — ('text', str) | ('tool', name) | ('sleep', secs)"""
        t = text.lower()
        if cue and "answered" in t:
            # The real hub serves this from the pre-generated opening line with zero fork latency.
            return [("text", self.greeting or "Hi Yousef, it's AL. This is a harness test call. Can you hear me alright?")]
        if cue:
            return [("text", "Hello? This is AL.")]
        if "hang up" in t or "hangup" in t or "bye" in t:
            return [("text", "Alright, bye Yousef.")]
        if "arabic" in t:
            return [("text", "تمام. "), ("text", "أنا بتكلم معاك بالعربي المصري دلوقتي. "), ("text", "Back to English now. Anything else?")]
        if "calendar" in t or "tomorrow" in t:
            return [("text", "Hold on, let me check the calendar. "), ("tool", "Bash"), ("sleep", 1.5), ("text", "Just the ten a.m. with Callum.")]
        if "story" in t:
            return [("text", f"Once upon a time, part {i}. ") for i in range(1, 30)]
        return [("text", f"I heard you say: {text.strip()} "), ("text", "Anything else?")]

    async def turn(self, req):
        body = await req.json()
        self.turn_requests.append(body)
        print(f"[fake-hub] turn: {json.dumps(body, ensure_ascii=False)}")
        self.interrupted.clear()
        resp = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
        await resp.prepare(req)
        t0 = time.monotonic()
        chars = 0
        first = None
        if not (body.get("cue") and "answered" in body.get("text", "").lower()):
            await asyncio.sleep(0.6)  # a Claude Code turn's TTFT, roughly
        for kind, payload in self.script(body.get("text", ""), bool(body.get("cue"))):
            if self.interrupted.is_set():
                break
            if kind == "text":
                if first is None:
                    first = time.monotonic()
                for word in str(payload).split(" "):
                    await resp.write((json.dumps({"type": "text", "text": word + " "}, ensure_ascii=False) + "\n").encode())
                    chars += len(word) + 1
                    await asyncio.sleep(0.04)
            elif kind == "tool":
                await resp.write((json.dumps({"type": "tool", "name": payload}) + "\n").encode())
            elif kind == "sleep":
                await asyncio.sleep(float(payload))
        await resp.write((json.dumps({"type": "result", "ms": int((time.monotonic() - t0) * 1000), "ttftMs": int((first - t0) * 1000) if first else None,
                                      "interrupted": self.interrupted.is_set(), "chars": chars}) + "\n").encode())
        await resp.write_eof()
        return resp

    async def interrupt(self, req):
        self.interrupts += 1
        self.interrupted.set()
        print("[fake-hub] interrupt")
        return web.json_response({"ok": True, "method": "control"})

    async def transcript_post(self, req):
        body = await req.json()
        if not self.transcript.done():
            self.transcript.set_result(body)
        return web.json_response({"ok": True, "file": "fake", "injected": True})


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wavs", nargs="+", default=[str(HERE / "q1.wav"), str(HERE / "q2.wav"), str(HERE / "q3.wav")])
    ap.add_argument("--inbound", action="store_true")
    ap.add_argument("--ring", type=float, default=4.0, help="seconds between dial and accept")
    ap.add_argument("--no-spawn", action="store_true", help="assume a pipeline is already running on 9979")
    ap.add_argument("--barge", action="store_true", help="turn 1 asks for a long story; the caller talks over it (checks interrupt + flush + interruptedAfter)")
    ap.add_argument("--arabic", action="store_true", help="turn 1 asks for Arabic; the scripted reply switches ar → en mid-turn (checks the language router, and that the next English utterance still transcribes)")
    ap.add_argument("--setup-fail", action="store_true", help="the TTS websocket is a tarpit, so Pipecat's setup times out after pickup (checks: hold-on clip, apology clip, hangup, transcript outcome=failed / PIPELINE SETUP FAILED)")
    args = ap.parse_args()
    if args.setup_fail:
        args.ring = min(args.ring, 1.0)
    if args.arabic:
        args.wavs = [str(HERE / "q5.wav"), str(HERE / "q3.wav")]
    if args.barge:
        args.wavs = [str(HERE / "q4.wav"), str(HERE / "q1.wav"), str(HERE / "q3.wav")]

    wavs = [] if args.setup_fail else [read_wav(Path(w)) for w in args.wavs]
    side = FakeSidecar(wavs, args.inbound, args.ring, args.barge)
    hub = FakeHub()

    ws_server = await websockets.serve(side.handler, "127.0.0.1", 9978, max_size=None)
    runner = web.AppRunner(hub.app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 9977).start()

    env = {
        **os.environ,
        "WA_VOICE_URL": "ws://127.0.0.1:9978",
        "CONSOLE_HUB_URL": "http://127.0.0.1:9977",
        "CONSOLE_VOICE_TOKEN": "test",
        "VOICE_PIPELINE_PORT": "9979",
        "CONSOLE_CONFIG_DIR": os.environ.get("CONSOLE_CONFIG_DIR", str(Path.home() / ".config" / "console")),
    }
    tarpit = None
    if args.setup_fail:
        # Accepts the TCP connection and never answers the websocket handshake:
        # the TTS blocks inside setup, which is exactly what call 008048b0 hit.
        async def _hold(_reader, writer):
            try:
                await asyncio.sleep(120)
            finally:
                writer.close()

        tarpit = await asyncio.start_server(_hold, "127.0.0.1", 9976)
        env["CARTESIA_TTS_URL"] = "ws://127.0.0.1:9976/tts/websocket"
        env["VOICE_SETUP_TIMEOUT"] = "5"
        env["VOICE_HOLD_ON_AFTER"] = "2"
        env["VOICE_SETUP_GRACE"] = "12"
    proc = None
    if not args.no_spawn:
        proc = subprocess.Popen([sys.executable, "-m", "al_voice.main"], env=env, cwd=str(HERE.parent))
    try:
        async with httpx.AsyncClient() as http:
            for _ in range(120):
                try:
                    r = await http.get("http://127.0.0.1:9979/health", timeout=6)
                    h = r.json() if r.status_code == 200 else {}
                    # The fallback clips render at boot (once; cached on disk).
                    if h.get("connected") and {"apology.en", "hold_on.en"} <= set((h.get("clips") or {}).get("ready", [])):
                        print(f"[harness] pipeline health: {json.dumps({k: h.get(k) for k in ('ok', 'hub', 'rtt_ms', 'cartesia', 'loopback', 'clips')})}")
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.5)
            else:
                raise SystemExit("pipeline never came up / never connected to the fake sidecar / clips never rendered")
            if not args.inbound:
                dial_at = time.monotonic()
                r = await http.post("http://127.0.0.1:9979/call", json={"jid": "447845443890@s.whatsapp.net", "task": "Tell Yousef this is a test call and ask if the audio sounds right."}, timeout=30)
                print("[harness] /call →", r.status_code, r.text)
        driver = asyncio.create_task(side.drive())
        payload = await asyncio.wait_for(hub.transcript, timeout=240)
        await driver
        out = HERE / f"out-{int(time.time())}.wav"
        write_wav(out, bytes(side.out))
        print(f"[harness] bot audio → {out} ({len(side.out) / 32000:.1f}s)")
        print(json.dumps({k: payload.get(k) for k in ("outcome", "reason", "durationMs", "toolCalls", "languageSwitches", "latency")}, indent=2, ensure_ascii=False))
        for t in payload.get("turns", []):
            print(f"  {t['t']:>7} {t['role'][:4]}  {t['text']}")

        turns = payload.get("turns", [])
        first_audio = (side.first_bot_audio - side.accepted_at) if (side.first_bot_audio and side.accepted_at) else None
        if args.setup_fail:
            clips = [t.get("clip") for t in turns if t.get("clip")]
            hangup_after_accept = (side.hangup_at - side.accepted_at) if (side.hangup_at and side.accepted_at) else None
            checks = {
                "transcript outcome = failed": payload.get("outcome") == "failed",
                "reason says PIPELINE SETUP FAILED": str(payload.get("reason", "")).startswith("PIPELINE SETUP FAILED"),
                "hold-on clip played while waiting": "hold_on" in clips,
                "apology clip played": "apology" in clips,
                "apology audio reached the slot (≥ 2 s of bot audio)": len(side.out) / 32000 >= 2.0,
                "hangup issued": side.hangup_at is not None,
                "hangup waited for the apology's playout": side.hangup_at is not None and side.hangup_at >= side.last_bot_audio - 0.05,
                "failed loud within the grace window (≤ 14 s after pickup)": hangup_after_accept is not None and hangup_after_accept <= 14.0,
            }
            print(f"[harness] setup: {json.dumps(payload.get('setup'))}")
            print(f"[harness] failed: {payload.get('failed')}")
            print(f"[harness] pickup → hangup: {hangup_after_accept:.1f}s" if hangup_after_accept is not None else "[harness] no hangup")
            for k, v in checks.items():
                print(f"  {'PASS' if v else 'FAIL'}  {k}")
            if not all(checks.values()):
                raise SystemExit(1)
            return
        if args.inbound:
            # the caller speaks 0.3 s after the answer, so the 2 s silence cue must not fire
            checks = {
                "no silence greeting while the caller was talking": not any("This is AL" in t["text"] for t in turns if t["role"] == "assistant"),
                "first audio ≤ 5 s after accept (reply to a 2 s utterance)": first_audio is not None and first_audio <= 5.0,
                "fork saw the caller's words first (no cue)": bool(hub.turn_requests) and hub.turn_requests[0].get("cue") is not True,
            }
        else:
            greetings = sum(1 for t in turns if t["role"] == "assistant" and "harness test call" in t["text"])
            checks = {
                "one greeting (not doubled)": greetings == 1,
                "first audio ≤ 3 s after accept": first_audio is not None and first_audio <= 3.0,
                "fork saw the answered cue first": bool(hub.turn_requests) and hub.turn_requests[0].get("cue") is True,
            }
        checks |= {
            "hangup issued after the caller asked": side.hangup_at is not None,
            "hangup waited for playout": side.hangup_at is not None and side.hangup_at >= side.last_bot_audio - 0.05,
            "transcript reason = hangup": payload.get("reason") == "hangup",
        }
        if args.arabic:
            checks["arabic turn switched languages (router)"] = (payload.get("languageSwitches") or 0) >= 2
            last_user = [t["text"] for t in turns if t["role"] == "user"][-1:]
            checks["english after the Arabic turn still transcribed"] = bool(last_user) and "hang" in last_user[0].lower()
        if args.barge:
            interrupted_reqs = [r for r in hub.turn_requests if r.get("interruptedAfter")]
            checks["barge-in flushed the sidecar queue"] = side.flushes >= 1
            checks["barge-in interrupted the fork"] = hub.interrupts >= 1
            checks["next utterance told the fork where it was cut off"] = bool(interrupted_reqs)
            if interrupted_reqs:
                print(f"[harness] interruptedAfter = {interrupted_reqs[0]['interruptedAfter']!r}")
        print(f"[harness] accept → first audio: {first_audio:.2f}s" if first_audio is not None else "[harness] no bot audio")
        print(f"[harness] fork turn requests: {len(hub.turn_requests)}, interrupts: {hub.interrupts}, flushes: {side.flushes}")
        print(f"[harness] caller speech end → first reply audio: {[round(x, 2) for x in side.reply_latencies]} s (fake fork TTFT 0.6 s included)")
        for k, v in checks.items():
            print(f"  {'PASS' if v else 'FAIL'}  {k}")
        if not all(checks.values()):
            raise SystemExit(1)
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
        ws_server.close()
        if tarpit:
            tarpit.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
