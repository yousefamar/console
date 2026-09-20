"""Benchmark: what a voice-fork turn costs per model.

Spawns `claude` exactly as the hub spawns a FRESH voice fork (stream-json in/out,
partial messages, AL's persona + the voice rules as --append-system-prompt, at
AL's workspace cwd, the same model ids), sends the call envelope as the warm
turn, then a few spoken utterances, and measures per turn: send → first text
delta (TTFT, what the caller waits before hearing anything) and send → result.

    uv run python tests/bench_fork_ttft.py --persona /tmp/persona.txt --models claude-haiku-4-5-20251001 arn:…

No hub, no sidecar, no WhatsApp. Prompts are benign; the model may still run
`date` or `con cal` — that is the point of a fork with tools."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENVELOPE = """[VOICE CALL OUTBOUND to Yousef (yousef, +447845443890) — callId BENCHCALL01]

---

## Who is on the call

Yousef (yousef, +447845443890) — this is Yousef himself, your owner. No restrictions apply.

---

## Call task

You are placing this call. Your task: This is a latency benchmark of the voice fork; keep every reply to one short sentence.

When the call is answered you will get the message "(The call was answered.)" — greet Yousef by name, say why you are calling, and begin. When the task is done, wrap up and say goodbye.

---

The call is connecting. Reply with exactly the word: ready"""

TURNS = [
    "(The call was answered.)",
    "Hello, yes, I can hear you fine.",
    "What time is it right now in London?",
    "Okay, thanks. Bye.",
]


def run(model: str, persona: str, cwd: str, turns: list[str]) -> list[dict]:
    args = [
        "claude", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
        "--include-partial-messages", "--dangerously-skip-permissions", "--model", model,
        "--append-system-prompt", persona,
    ]
    env = {**os.environ, "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h"}
    proc = subprocess.Popen(args, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    assert proc.stdin and proc.stdout
    results = []
    for i, text in enumerate([ENVELOPE, *turns]):
        t0 = time.monotonic()
        proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
        proc.stdin.flush()
        first_text = None
        first_tool = None
        tools = []
        spoken = ""
        result = None
        while True:
            line = proc.stdout.readline()
            if not line:
                raise SystemExit(f"{model}: claude exited early: {proc.stderr.read()[:500]}")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = msg.get("type")
            if t == "stream_event":
                ev = msg.get("event", {})
                if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                    if first_text is None:
                        first_text = time.monotonic() - t0
                    spoken += ev["delta"]["text"]
                elif ev.get("type") == "content_block_start" and ev.get("content_block", {}).get("type") == "tool_use":
                    if first_tool is None:
                        first_tool = time.monotonic() - t0
                    tools.append(ev["content_block"].get("name"))
            elif t == "result":
                result = msg
                break
        total = time.monotonic() - t0
        usage = result.get("usage", {}) if result else {}
        row = {
            "turn": i, "text": text[:40], "ttft_ms": round(first_text * 1000) if first_text is not None else None,
            "first_tool_ms": round(first_tool * 1000) if first_tool is not None else None, "tools": tools,
            "total_ms": round(total * 1000), "spoken": spoken.strip()[:120],
            "cache_read": usage.get("cache_read_input_tokens"), "cache_write": usage.get("cache_creation_input_tokens"),
            "reported_ttft_ms": result.get("ttft_ms") if result else None,
        }
        results.append(row)
        print(f"  [{model.split('/')[-1][:28]:<28}] t{i} ttft={row['ttft_ms']} total={row['total_ms']} tools={tools} cache_read={row['cache_read']} → {row['spoken'][:80]!r}", flush=True)
    proc.stdin.close()
    proc.wait(10)
    return results


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--persona", required=True)
    ap.add_argument("--cwd", default=str(Path.home() / "sync/brain/root/projects/al/workspace"))
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--out", default="/tmp/bench-fork-ttft.json")
    args = ap.parse_args()
    persona = Path(args.persona).read_text()
    out = {}
    for m in args.models:
        print(f"== {m}", flush=True)
        try:
            out[m] = run(m, persona, args.cwd, TURNS)
        except SystemExit as e:
            print(f"  failed: {e}", flush=True)
            out[m] = {"error": str(e)}
    Path(args.out).write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
