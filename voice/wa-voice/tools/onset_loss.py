#!/usr/bin/env python3
"""Per-onset loss on a WhatsApp call: what the phone PLAYED vs what we SENT.

Inputs (all written by the sidecar into ~/.cache/console/voice-wire/):
  <callId>.log        wire log — `onset lever=… ` / `preroll start …` / `idle after …` lines
  <callId>-tx.wav     exactly what the encoder was fed (WA_VOICE_CAPTURE=1)
  <callId>-room.wav   this machine's mic during the call (WA_VOICE_ROOM_CAPTURE=<source>),
                      i.e. the phone's speaker, if the phone was on speaker at the desk

For every AL onset: aligns the room recording to tx (global lag, then a local
refinement on the body of the utterance, which the phone plays intact), then
reports how much of the utterance start is missing from the room in ms, the
attenuation of the first 600 ms in 100 ms bins (the shape of whatever eats the
onset), and — for pre-roll levers — how much of the pre-roll was heard (a 440 Hz
tone is detected by Goertzel, noise by level). Grouped by the sweep lever that
governed each onset (`WA_VOICE_SWEEP`), so ONE call answers every A/B at once.

    tools/onset_loss.py <callId> [--dir DIR] [--json]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import wave
from collections import defaultdict
from pathlib import Path

import numpy as np

SR = 16_000
HOP = SR // 100  # 10 ms envelope frames
HANGOVER_MS = 480  # MicSource: `idle after` is written this long after the last speech frame
FLOOR_DB = -120.0


def load_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        sys.exit(f"{path}: want 16-bit PCM, got {sw * 8}-bit")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != SR:
        if sr % SR:
            sys.exit(f"{path}: {sr} Hz is not a multiple of {SR}")
        x = x[:: sr // SR]
    return x


def envelope_db(x: np.ndarray) -> np.ndarray:
    n = len(x) // HOP
    if n == 0:
        return np.full(0, FLOOR_DB)
    frames = x[: n * HOP].reshape(n, HOP)
    rms = np.sqrt((frames * frames).mean(axis=1))
    return np.where(rms > 0, 20 * np.log10(np.maximum(rms, 1e-9)), FLOOR_DB)


def goertzel_db(x: np.ndarray, freq: float) -> np.ndarray:
    """Per-10 ms-frame power at `freq` relative to full scale, in dB."""
    n = len(x) // HOP
    if n == 0:
        return np.full(0, FLOOR_DB)
    frames = x[: n * HOP].reshape(n, HOP)
    t = np.arange(HOP) / SR
    ref = np.exp(-2j * np.pi * freq * t)
    mag = np.abs(frames @ ref) * 2 / HOP  # amplitude of that component
    return np.where(mag > 0, 20 * np.log10(np.maximum(mag / math.sqrt(2), 1e-9)), FLOOR_DB)


LINE = re.compile(r"^\s*(\d+)\s+(.*)$")
LEVER = re.compile(r"lever=(\S+)")


def parse_log(path: Path) -> dict:
    onsets, prerolls, idles, room_start = [], [], [], None
    for raw in path.read_text(errors="replace").splitlines():
        m = LINE.match(raw)
        if not m:
            continue
        t, rest = int(m.group(1)), m.group(2)
        lever = LEVER.search(rest)
        label = lever.group(1) if lever else "?"
        if rest.startswith("onset "):
            onsets.append({"t": t, "lever": label, "kind": "onset"})
        elif rest.startswith("preroll start "):
            fm = re.search(r"frames=(\d+)", rest)
            prerolls.append({"t": t, "lever": label, "kind": "preroll", "preroll_ms": 60 * int(fm.group(1)) if fm else 0})
        elif rest.startswith("idle after "):
            idles.append(t)
        elif rest.startswith("room capture start"):
            room_start = t
    # A talkspurt with a pre-roll never writes an `onset` line (MicSource goes Preroll → Speaking).
    starts = sorted(onsets + prerolls, key=lambda e: e["t"])
    return {"starts": starts, "idles": idles, "room_start_ms": room_start}


def xcorr_lag(a: np.ndarray, b: np.ndarray, lags: range) -> tuple[int, float]:
    """Lag k maximising corr(a[i], b[i+k]); both already mean-removed."""
    best, best_c = 0, -1.0
    na = np.linalg.norm(a) or 1.0
    for k in lags:
        if k >= 0:
            x, y = a[: len(a) - k] if k else a, b[k : k + len(a)]
        else:
            x, y = a[-k:], b[: len(a) + k]
        m = min(len(x), len(y))
        if m < 20:
            continue
        x, y = x[:m], y[:m]
        c = float(np.dot(x, y) / (na * (np.linalg.norm(y) or 1.0)))
        if c > best_c:
            best, best_c = k, c
    return best, best_c


def speech_mask(env: np.ndarray, floor: float, margin: float) -> np.ndarray:
    return np.clip(env - (floor + margin), 0, None)


def first_sustained(mask: np.ndarray, start: int, stop: int, need: int = 3) -> int | None:
    run = 0
    for i in range(max(start, 0), min(stop, len(mask))):
        run = run + 1 if mask[i] else 0
        if run >= need:
            return i - need + 1
    return None


def analyse(call_id: str, d: Path) -> dict:
    log = parse_log(d / f"{call_id}.log")
    tx = load_wav(d / f"{call_id}-tx.wav")
    room_path = d / f"{call_id}-room.wav"
    if not room_path.exists():
        sys.exit(f"{room_path} missing — the call ran without WA_VOICE_ROOM_CAPTURE, nothing to compare against")
    room = load_wav(room_path)
    tx_env, room_env = envelope_db(tx), envelope_db(room)
    room_tone = goertzel_db(room, 440.0)

    tx_floor = float(np.percentile(tx_env, 20))
    room_floor = float(np.percentile(room_env, 20))
    # Global lag on speech-shaped envelopes (everything under floor+8 dB flattened).
    a = speech_mask(tx_env, tx_floor, 8.0)
    b = speech_mask(room_env, room_floor, 8.0)
    a, b = a - a.mean(), b - b.mean()
    lag, corr = xcorr_lag(a, b, range(-200, 600))  # room may lead tx by ≤2 s or trail by ≤6 s
    out = {
        "callId": call_id,
        "tx_s": len(tx) / SR,
        "room_s": len(room) / SR,
        "global_lag_ms": lag * 10,
        "global_corr": round(corr, 3),
        "tx_floor_db": round(tx_floor, 1),
        "room_floor_db": round(room_floor, 1),
        "onsets": [],
    }
    if corr < 0.15:
        out["warning"] = "weak alignment — was the phone on speaker near the mic?"

    starts, idles = log["starts"], log["idles"]
    # tx.wav sample 0 is the first ticker frame, ~60 ms after `open`; the onset is then
    # located by level inside a window around the logged time, so this only needs to be close.
    tick0_ms = 60
    for i, ev in enumerate(starts):
        t_ms = ev["t"] - tick0_ms
        f0 = t_ms // 10
        next_start = starts[i + 1]["t"] - tick0_ms if i + 1 < len(starts) else None
        idle_after = next((t for t in idles if t > ev["t"]), None)
        end_ms = min(
            x for x in [next_start, (idle_after - tick0_ms - HANGOVER_MS) if idle_after else None, t_ms + 8000] if x is not None
        )
        f_end = max(end_ms // 10, f0 + 30)
        rec = {"n": i + 1, "t_s": round(ev["t"] / 1000, 2), "lever": ev["lever"], "kind": ev["kind"]}
        # First signal in tx: above the idle floor by 12 dB and above -48 dBFS. With a
        # pre-roll that IS the pre-roll; the speech follows it contiguously (MicSource).
        tx_thr = max(tx_floor + 12.0, -48.0)
        s_sig = first_sustained(tx_env > tx_thr, f0 - 10, f0 + 80, need=2)
        pre_ms = ev.get("preroll_ms", 0)
        if s_sig is None:
            rec["note"] = "no speech in tx within 800 ms of the onset"
            out["onsets"].append(rec)
            continue
        s_pre, s_tx = s_sig, s_sig + pre_ms // 10
        body0, body1 = s_tx + 40, min(f_end, len(tx_env), len(room_env) - lag - 1)
        if body1 - body0 < 30:
            rec["note"] = "utterance too short to align (<300 ms of body)"
            out["onsets"].append(rec)
            continue
        # Local refinement: the body of the utterance is played intact, so align on that.
        seg = speech_mask(tx_env[body0:body1], tx_floor, 8.0)
        seg = seg - seg.mean()
        lo, hi = max(lag - 15, -body0), lag + 15
        rmask = speech_mask(room_env, room_floor, 8.0)
        rwin = rmask[body0 + lo : body1 + hi + 1]
        k, c = xcorr_lag(seg, rwin - rwin.mean(), range(0, hi - lo + 1))
        local_lag = lo + k
        rec["lag_ms"] = local_lag * 10
        rec["align_corr"] = round(c, 2)

        def R(f: int) -> float:  # room envelope at tx frame f
            j = f + local_lag
            return float(room_env[j]) if 0 <= j < len(room_env) else FLOOR_DB

        base_f = max(s_pre - 100, 0)
        r_al = np.array([R(f) for f in range(base_f, body1)])
        # Room noise in the second before anything was sent, for the "heard" threshold.
        pre0, pre1 = max(s_pre - 100, 0), max(s_pre - 5, 1)
        r_pre = np.array([R(f) for f in range(pre0, pre1)])
        r_quiet = float(np.median(r_pre))
        body_room = float(np.median([R(f) for f in range(body0, body1)]))
        body_tx = float(np.median(tx_env[body0:body1]))
        thr = max(r_quiet + 8.0, body_room - 25.0)
        rec["room_quiet_db"] = round(r_quiet, 1)
        rec["room_body_db"] = round(body_room, 1)
        if (r_pre[-30:] > thr).mean() > 0.3:
            rec["note"] = "room already loud before the onset (overlap with the caller?)"
        heard = first_sustained(r_al > thr, s_pre - base_f - 10, body1 - base_f, need=3)
        if heard is None:
            rec["loss_ms"] = None
            rec["note"] = (rec.get("note", "") + " nothing of this utterance reached the room").strip()
        else:
            # Relative to the SPEECH start: negative = the pre-roll itself was heard from there.
            rec["loss_ms"] = (heard + base_f - s_tx) * 10
        # Attack curve: room minus tx, relative to the steady state, per 100 ms bin after tx speech start.
        gain_ref = body_room - body_tx
        bins = []
        for k in range(6):
            f_lo, f_hi = s_tx + 10 * k, min(s_tx + 10 * (k + 1), body1)
            if f_hi <= f_lo:
                break
            diff = np.array([R(f) for f in range(f_lo, f_hi)]) - tx_env[f_lo:f_hi] - gain_ref
            # Only frames where tx actually has signal count (silence in tx is not "lost").
            keep = tx_env[f_lo:f_hi] > tx_thr
            bins.append(round(float(np.median(diff[keep])), 1) if keep.any() else None)
        rec["attack_db_per_100ms"] = bins
        if pre_ms:
            def T(f: int) -> float:  # 440 Hz power in the room at tx frame f
                j = f + local_lag
                return float(room_tone[j]) if 0 <= j < len(room_tone) else FLOOR_DB

            lvl = np.array([R(f) for f in range(s_pre, s_tx)])
            if "tone" in ev["lever"]:
                tone_floor = float(np.median([T(f) for f in range(pre0, pre1)]))
                heard_f = sum(1 for f in range(s_pre, s_tx) if T(f) > tone_floor + 10.0)
                rec["preroll_heard_ms"] = heard_f * 10
                rec["preroll_kind"] = "tone"
            else:
                rec["preroll_heard_ms"] = int((lvl > thr).sum()) * 10
                rec["preroll_kind"] = "noise"
            rec["preroll_ms"] = pre_ms
        out["onsets"].append(rec)

    by_lever: dict[str, list] = defaultdict(list)
    for r in out["onsets"]:
        if "loss_ms" in r:
            by_lever[r["lever"]].append(r)
    out["by_lever"] = {}
    for lever, rs in by_lever.items():
        losses = [r["loss_ms"] for r in rs if r["loss_ms"] is not None]
        muted = sum(1 for r in rs if r["loss_ms"] is None)
        out["by_lever"][lever] = {
            "n": len(rs),
            "median_loss_ms": int(np.median(losses)) if losses else None,
            "losses_ms": losses,
            "nothing_heard": muted,
        }
    return out


def print_report(o: dict) -> None:
    print(f"call {o['callId']}: tx {o['tx_s']:.1f} s, room {o['room_s']:.1f} s, global lag {o['global_lag_ms']} ms (corr {o['global_corr']})")
    print(f"floors: tx {o['tx_floor_db']} dBFS, room {o['room_floor_db']} dBFS")
    if o.get("warning"):
        print(f"WARNING: {o['warning']}")
    print()
    print(f"{'#':>2} {'t(s)':>7} {'lever':<28} {'loss':>7} {'attack dB per 100 ms (room−tx, rel. body)':<44} pre-roll")
    for r in o["onsets"]:
        if "loss_ms" not in r:
            print(f"{r['n']:>2} {r['t_s']:>7} {r['lever']:<28} {'—':>7} {r.get('note', '')}")
            continue
        loss = "MUTED" if r["loss_ms"] is None else f"{r['loss_ms']:>4} ms"
        atk = " ".join(f"{b:+5.1f}" if b is not None else "   — " for b in r["attack_db_per_100ms"])
        pre = f"{r['preroll_heard_ms']}/{r['preroll_ms']} ms of {r['preroll_kind']} heard" if r.get("preroll_ms") else ""
        note = f"  ({r['note']})" if r.get("note") else ""
        print(f"{r['n']:>2} {r['t_s']:>7} {r['lever']:<28} {loss:>7} {atk:<44} {pre}{note}")
    print()
    print("by lever:")
    for lever, s in o["by_lever"].items():
        med = "—" if s["median_loss_ms"] is None else f"{s['median_loss_ms']} ms"
        print(f"  {lever:<28} n={s['n']}  median loss {med:<8} losses {s['losses_ms']}  nothing heard: {s['nothing_heard']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("call_id")
    ap.add_argument("--dir", default=os.path.expanduser("~/.cache/console/voice-wire"))
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    d = Path(a.dir)
    cid = a.call_id
    if not (d / f"{cid}.log").exists():
        cands = sorted(d.glob(f"{cid}*.log"))
        if len(cands) != 1:
            sys.exit(f"no unique {cid}*.log in {d}")
        cid = cands[0].stem
    o = analyse(cid, d)
    if a.json:
        print(json.dumps(o, indent=1))
    else:
        print_report(o)


if __name__ == "__main__":
    main()
