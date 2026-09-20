"""End-to-end harness without WhatsApp: a fake wa-voice socket + a fake hub.

    uv run python tests/harness.py --wav tests/q.wav [--inbound] [--turns 2]

Starts (1) a fake sidecar on ws://127.0.0.1:9978 that speaks the real
protocol, streams `--wav` (16 kHz mono s16) into the call at real time each
time the bot goes quiet, and records what the bot says to `tests/out-*.wav`;
(2) a fake hub on http://127.0.0.1:9977 serving /voice/context, /voice/delegate
and /voice/transcript. Then it launches the real pipeline process pointed at
both and places (or receives) one call. Prints the transcript payload the
pipeline posted, including the latency block."""

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
    def __init__(self, wav: bytes, turns: int, inbound: bool):
        self.wav = wav
        self.turns = turns
        self.inbound = inbound
        self.ws = None
        self.out = bytearray()
        self.call_id = "TESTCALL1"
        self.last_bot_audio = 0.0
        self.bot_spoke = asyncio.Event()
        self.ended = asyncio.Event()
        self.answered = asyncio.Event()

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
                    self.bot_spoke.set()
                continue
            cmd = json.loads(msg)
            c = cmd.get("cmd")
            if c == "call":
                await self.send({"ev": "ack", "cmd": "call", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "ringing", "callId": self.call_id, "slot": 0})
                await asyncio.sleep(1.0)
                await self.send({"ev": "accepted", "callId": self.call_id, "slot": 0})
                self.answered.set()
            elif c == "answer":
                await self.send({"ev": "ack", "cmd": "answer", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "accepted", "callId": self.call_id, "slot": 0})
                self.answered.set()
            elif c == "reject":
                await self.send({"ev": "ack", "cmd": "reject", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "rejected", "durationMs": 0})
                self.ended.set()
            elif c == "hangup":
                await self.send({"ev": "ack", "cmd": "hangup", "callId": self.call_id, "slot": 0, "id": cmd.get("id")})
                await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "local", "durationMs": 1000})
                self.ended.set()
            elif c == "flush":
                print("[harness] flush (barge-in) received")
            elif c == "status":
                await self.send({"ev": "status", "connected": True, "paired": True, "jid": "x", "calls": [], "id": cmd.get("id")})

    async def stream_wav(self):
        """Play the question into the call at real time."""
        t0 = time.monotonic()
        for i in range(0, len(self.wav), FRAME):
            chunk = self.wav[i:i + FRAME]
            if len(chunk) < FRAME:
                chunk = chunk + b"\0" * (FRAME - len(chunk))
            await self.ws.send(bytes((0,)) + chunk)
            await asyncio.sleep(max(0, t0 + (i // FRAME + 1) * 0.06 - time.monotonic()))
        # trailing silence so VAD closes the turn
        for _ in range(20):
            await self.ws.send(bytes((0,)) + b"\0" * FRAME)
            await asyncio.sleep(0.06)

    async def drive(self):
        await self.answered.wait()
        await asyncio.sleep(0.5)
        for turn in range(self.turns):
            # keep silence flowing while waiting for the bot (outbound greets first)
            if turn == 0 and not self.inbound:
                await self.wait_quiet(first=True)
            print(f"[harness] speaking turn {turn + 1}")
            await self.stream_wav()
            await self.wait_quiet()
        await asyncio.sleep(0.5)
        await self.send({"ev": "ended", "callId": self.call_id, "slot": 0, "reason": "peer", "durationMs": 10_000})
        self.ended.set()

    async def wait_quiet(self, first=False):
        """Feed silence until the bot has spoken and then been quiet for 1.2 s."""
        self.bot_spoke.clear()
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            await self.ws.send(bytes((0,)) + b"\0" * FRAME)
            await asyncio.sleep(0.06)
            if self.bot_spoke.is_set() and time.monotonic() - self.last_bot_audio > 1.2:
                return
        print("[harness] bot never spoke (timeout)")


class FakeHub:
    def __init__(self):
        self.transcript = asyncio.Future()
        self.app = web.Application()
        self.app.add_routes([
            web.get("/voice/context", self.context),
            web.post("/voice/delegate", self.delegate),
            web.post("/voice/transcript", self.transcript_post),
            web.get("/voice/health", lambda r: web.json_response({"ok": True})),
        ])

    async def context(self, req):
        task = req.query.get("task")
        prompt = (
            "You are AL, Yousef Amar's assistant, speaking on a WhatsApp voice call in Yousef's own voice. "
            "Short spoken sentences, no lists, no markdown. You are talking to Yousef himself (the owner). "
            "Use the delegate tool for anything you cannot answer from this prompt — calendar, messages, files. "
            "Never mention delegation or tools; do not preface a tool call with speech."
        )
        if task:
            prompt += f"\n\n## Call task\nThis is an outbound call you placed. Your task: {task}. Open the call by saying hello and stating why you are calling."
        return web.json_response({"answer": True, "why": "owner", "systemPrompt": prompt, "displayName": "Yousef", "user": "yousef"})

    async def delegate(self, req):
        body = await req.json()
        print(f"[fake-hub] delegate: {body.get('request')!r}")
        await asyncio.sleep(2.0)
        return web.json_response({"response": "Tomorrow you have a ten a.m. call with Callum and nothing else."})

    async def transcript_post(self, req):
        body = await req.json()
        if not self.transcript.done():
            self.transcript.set_result(body)
        return web.json_response({"ok": True})


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default=str(HERE / "q.wav"))
    ap.add_argument("--inbound", action="store_true")
    ap.add_argument("--turns", type=int, default=2)
    ap.add_argument("--no-spawn", action="store_true", help="assume a pipeline is already running on 9979")
    args = ap.parse_args()

    wav = read_wav(Path(args.wav))
    side = FakeSidecar(wav, args.turns, args.inbound)
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
    }
    proc = None
    if not args.no_spawn:
        proc = subprocess.Popen([sys.executable, "-m", "al_voice.main"], env=env, cwd=str(HERE.parent))
    try:
        async with httpx.AsyncClient() as http:
            for _ in range(60):
                try:
                    r = await http.get("http://127.0.0.1:9979/health", timeout=1)
                    if r.status_code == 200 and r.json().get("connected"):
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.5)
            else:
                raise SystemExit("pipeline never came up / never connected to the fake sidecar")
            if not args.inbound:
                r = await http.post("http://127.0.0.1:9979/call", json={"jid": "447845443890@s.whatsapp.net", "task": "Tell Yousef this is a test call and ask if the audio sounds right."}, timeout=30)
                print("[harness] /call →", r.status_code, r.text)
        driver = asyncio.create_task(side.drive())
        payload = await asyncio.wait_for(hub.transcript, timeout=180)
        await driver
        out = HERE / f"out-{int(time.time())}.wav"
        write_wav(out, bytes(side.out))
        print(f"[harness] bot audio → {out} ({len(side.out) / 32000:.1f}s)")
        print(json.dumps({k: payload[k] for k in ("outcome", "durationMs", "turns", "delegations", "latency")}, indent=2, ensure_ascii=False))
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
        ws_server.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
