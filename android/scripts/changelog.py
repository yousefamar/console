#!/usr/bin/env python3
"""The in-app "What's new" list, derived from android/BACKLOG.md.

Prints a JSON array, newest version first:
    [{"versionCode": 113, "date": "2026-10-10", "items": ["…", "…"]}, …]

One item per top-level backlog entry: its bold lead-in, or for an unbolded
entry the text up to the first parenthesis / sentence end. The "Built,
awaiting release" block is the version being built (--version-code); each
`### vN (date)` section under "Shipped" is a past one. build-release.sh embeds
the array in latest.json, which is all the phone reads.
"""
import argparse
import datetime
import json
import re
import sys

HEADING = re.compile(r"^### v(\d+)\s*\(([^)]*)\)")
MAX_TITLE = 140


def entries(lines):
    """Each top-level `- ` bullet's lead paragraph, continuation lines joined."""
    out, cur = [], None
    for line in lines:
        if line.startswith("- "):
            if cur is not None:
                out.append(cur)
            cur = line[2:].strip()
        elif cur is not None and line.startswith("  ") and line.strip() and not line.lstrip().startswith("- "):
            cur += " " + line.strip()
        elif cur is not None:
            out.append(cur)
            cur = None
    if cur is not None:
        out.append(cur)
    return out


def title(text):
    text = text.strip()
    if text.startswith("**"):
        end = text.find("**", 2)
        t = text[2:end] if end > 0 else text[2:]
    else:
        cut = len(text)
        for delim in (" (", ". ", " — ", " – "):
            i = text.find(delim)
            if 0 < i < cut:
                cut = i
        t = text[:cut]
    t = re.sub(r"\s*\(\^[^)]*\)", "", t)  # a card id inside a bold title
    t = t.replace("`", "")
    t = re.sub(r"\s+", " ", t).strip().rstrip(".:;,")
    if len(t) > MAX_TITLE:
        t = t[: MAX_TITLE - 1].rsplit(" ", 1)[0] + "…"
    return t


def build(markdown, version_code, today, limit):
    built, shipped, cur, mode = [], {}, None, None
    for line in markdown.split("\n"):
        if line.startswith("## "):
            mode = (
                "built" if line.startswith("## Built, awaiting release")
                else "shipped" if line.startswith("## Shipped")
                else None
            )
            cur = None
            continue
        m = HEADING.match(line)
        if m and mode == "shipped":
            cur = (int(m.group(1)), m.group(2).strip())
            shipped[cur] = []
            continue
        if mode == "built":
            built.append(line)
        elif mode == "shipped" and cur is not None:
            shipped[cur].append(line)

    versions = [
        {"versionCode": code, "date": date, "items": [t for t in map(title, entries(lines)) if t]}
        for (code, date), lines in shipped.items()
    ]
    pending = [t for t in map(title, entries(built)) if t]
    if pending:
        if any(v["versionCode"] == version_code for v in versions):
            raise SystemExit(
                f"changelog: BACKLOG.md has entries awaiting release, but v{version_code} is already "
                "under Shipped. Bump vCode in app/build.gradle.kts before building."
            )
        versions.append({"versionCode": version_code, "date": today, "items": pending})

    versions = [v for v in versions if v["items"] and v["versionCode"] <= version_code]
    versions.sort(key=lambda v: -v["versionCode"])
    return versions[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--backlog", required=True)
    ap.add_argument("--version-code", type=int, required=True)
    ap.add_argument("--date", default=datetime.date.today().isoformat(), help="date of the build (default: today)")
    ap.add_argument("--limit", type=int, default=20, help="newest N versions to keep")
    args = ap.parse_args()
    with open(args.backlog, encoding="utf-8") as f:
        markdown = f.read()
    json.dump(build(markdown, args.version_code, args.date, args.limit), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
