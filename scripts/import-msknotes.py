#!/usr/bin/env python3
"""Import a Moleskine Notes `.msknotes` export (Google Drive backup) into the
Console vault as lossless pen pages.

The .msknotes is a zip: Data/<NNNN>.page_store/page.data (binary page store,
magic `msk` v1 — Moleskine's fork of NeoLAB's `neo` v2 "NeoNote data" format,
spec in /tmp/pen-research/Documentations/NeoNote_data_Eng_20160117.pdf and
docs/neo-pen-protocol.md §10) + optional Audio/*.m4a voice memos + NoteInfo.xml.

Unlike the app's SVG export (render-only), page.data carries the FULL source:
per-dot x/y (Ncode floats), PRESSURE (normalized 0..1) and time-diffs, plus
per-stroke color/thickness/startTime. We convert to our PenPageDoc (force =
pressure × 480, matching the live pipeline's FORCE_REF scale) and render via
server/src/pen/page-codec.ts renderPageSvg so imported pages are identical in
format to live-streamed ones.

Usage:
  scripts/import-msknotes.py <file.msknotes> [--vault ~/sync/brain/root] [--notebook <name>]

Writes scratch/pen/<notebook>/page-<N>.svg for every page store in the archive
(notebook defaults to the .msknotes basename). Requires npx/tsx (uses the real
renderPageSvg — no duplicated rendering logic).
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile

FORCE_REF = 480  # keep in sync with server/src/pen/page-codec.ts


def parse_page_data(buf: bytes) -> dict:
    """Binary page store → PenPageDoc dict (see docs/neo-pen-protocol.md §10)."""
    if buf[:3] != b"msk":
        raise ValueError(f"bad magic {buf[:3]!r} (expected b'msk')")
    note = struct.unpack_from("<I", buf, 7)[0]
    page = struct.unpack_from("<I", buf, 11)[0]
    # width/height f32 @15/@19 (page size in Ncode units), created/modified u64 @23/@31
    modified = struct.unpack_from("<Q", buf, 31)[0]
    n_strokes = struct.unpack_from("<I", buf, 41)[0]
    off = 45
    strokes = []
    for _ in range(n_strokes):
        # type u8 | color u32 (ARGB) | u8 | thickness f32 | startTime u64 | numDots u32
        nd = struct.unpack_from("<I", buf, off + 18)[0]
        off += 22
        dots = []
        t = 0
        for _ in range(nd):
            x, y, p = struct.unpack_from("<fff", buf, off)
            t += buf[off + 12]  # timeDiff u8, ms since previous dot
            off += 13
            dots.append({"x": round(x, 2), "y": round(y, 2), "force": round(p * FORCE_REF), "t": t})
        strokes.append({"dots": dots})
    return {
        "v": 1, "section": 3, "owner": 27, "note": note, "page": page, "unit": "ncode",
        "bbox": {"minX": 0, "minY": 0, "maxX": 1, "maxY": 1},
        "strokes": strokes, "updatedAt": modified,
    }


def render_to_vault(doc: dict, vault: str, notebook: str) -> str:
    rel = f"scratch/pen/{notebook}/page-{doc['page']}.svg"
    out = os.path.join(vault, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as jf:
        json.dump(doc, jf)
        jpath = jf.name
    script = (
        "import { readFileSync, writeFileSync } from 'node:fs'\n"
        f"import {{ renderPageSvg }} from '{repo}/server/src/pen/page-codec.js'\n"
        f"const doc = JSON.parse(readFileSync('{jpath}', 'utf-8'))\n"
        f"writeFileSync('{out}', renderPageSvg(doc))\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".mts", delete=False) as tf:
        tf.write(script)
        tpath = tf.name
    subprocess.run(["npx", "tsx", tpath], check=True, cwd=os.path.join(repo, "server"))
    os.unlink(jpath)
    os.unlink(tpath)
    return rel


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("msknotes")
    ap.add_argument("--vault", default=os.path.expanduser("~/sync/brain/root"))
    ap.add_argument("--notebook", default=None, help="vault folder name (default: file basename)")
    args = ap.parse_args()
    notebook = args.notebook or os.path.basename(args.msknotes).replace(".msknotes", "")
    with zipfile.ZipFile(args.msknotes) as z:
        stores = [n for n in z.namelist() if n.endswith("page.data")]
        if not stores:
            sys.exit("no page.data stores in archive")
        for name in sorted(stores):
            doc = parse_page_data(z.read(name))
            rel = render_to_vault(doc, args.vault, notebook)
            dots = sum(len(s["dots"]) for s in doc["strokes"])
            print(f"{name} → {rel}  ({len(doc['strokes'])} strokes, {dots} dots)")
        audio = [n for n in z.namelist() if n.startswith("Audio/") and n.endswith(".m4a")]
        if audio:
            print(f"note: {len(audio)} audio memo(s) in archive (not imported): {', '.join(audio)}")


if __name__ == "__main__":
    main()
