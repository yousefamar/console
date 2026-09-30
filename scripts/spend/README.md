# Spend attribution from Claude Code transcripts

Reads the last 7 days of `~/.claude/projects/*/*.jsonl` and attributes real per-request
`usage` (cache_read / cache_creation / input / output) to what occupied the context.
Ground truth for the token counts is the API's own `usage` field; the split across
context parts is proportional to each part's measured size in the prefix that request read.

- `attribute.py`   — share of spend by context part (Bash output, tool args, system prompt, Read, …)
- `cold-vs-warm.py` — cold (whole prompt rebuilt) vs warm vs read, in $ at per-model Bedrock
                     rates with the `cache_creation.ephemeral_{5m,1h}` split, bucketed by why
                     each cold request was cold (invalidating edit / TTL lapse / hibernation
                     window / >1h wake / fresh spawn)
- `ttl-policy.py`  — simulates TTL × hibernation-threshold policies per session over real
                     traces (a `--resume` respawn always rewrites — warm ⟺ gap < min(TTL, hib))
- `requests.py`   — requests/day attributed by wake source (board dispatch, cron, listener,
                     merge fold-in, hub-restart nudge, user) — the request-count half of the bill
- `extract.py`    — one pass over every JSONL → a compact per-request ledger (usage split, $ at
                     Bedrock rates, model, CLI version, effort, session, wake source) plus wake and
                     tool-result records: `extract.py 2026-09-01 2026-09-30 ~/.cache/spend/sep.jsonl`
                     (~3 min for 2 GB); every other question is then a few seconds over that file
- `sessions.py`   — over an extract: top sessions by $ (reads/writes/output, avg+max context, model,
                     wake source, fork context) or `--by src|proj|model|effort|day|cwd` roll-ups;
                     names from the hub manifest + fork-cost.jsonl + the recall index

Gotchas that produced wrong answers the first time (2026-09-08 ^odd-toad, 2026-09-21 ^lime-kiwi):
- Files' mtime says nothing about their lines' age: transcripts hold weeks of history, so
  cut on each line's `timestamp` too or "last 7 days" quietly becomes ~3 weeks (2.5× inflated).
- Fable 5.1 cache reads are repriced ($0.25/MTok = 0.025× base); Fable 5 and everything else
  read at 0.1× base. Weighting reads at 0.1× across the board overstates read spend 4×.
- Fork-session copies duplicate the parent's transcript lines in a second file — dedupe by
  `message.id` GLOBALLY, not per file.
- Images bill by dimensions (w×h/750, longest edge capped at 1568), NOT by base64 length —
  a char-count proxy overstates a 1920×1080 screenshot 27× (50k vs 1,844 tokens).
- JSONLs log ~40% of assistant requests twice (same `message.id`); dedupe by id or every
  total is inflated and a fake "cold request seconds after the last" bucket appears.
- Char→token proxy (chars/3.7) is only used for the RELATIVE split of a prompt; never sum
  it as an absolute.
Scale the cost-weight shares to the real AWS figure from `GET /dashboard/costs`.
- A remote MCP plugin (Stripe, 2026-09-22) made ~1% of consecutive requests rewrite the whole
  history with the system prefix still cached (tools arrive after a spawn's first request and
  flap mid-session — `deferred_tools_delta` attachments). Looked exactly like a TTL regression
  because it landed the same evening; split by `version`/TTL and by plugin install time first.
- Superseded 2026-09-30 (^spry-bear): the doubled writes are the CLI, not Stripe — on 2.1.280 the
  SECOND request of a resumed/spawned process is a full rewrite (only the ~25k tools block hits)
  22% of the time vs 1.9% on 2.1.263, same for 5m and 1h TTL, still there after the plugin was
  disabled; the rate rises with the gap between request 1 and 2 (<10 s 1%, 20–40 s 32%, >40 s
  45%) — something asynchronous settles 10–40 s after spawn and changes the prompt. Detector:
  first request cold (`cr<60k, cw>100k`), next request within 10 min also `cr<60k` and
  `cw>0.7×` the first. `prompt_snapshot` attachments hold the system prompt + tools for diffing
  (the `cliPrefix` field flips ''→set between them on every spawn and is NOT a byte change —
  a fresh 2.1.280 session hits fully on request 2).
- Session rank is by $, not requests: 9 card forks that reached 900k+ context cost $532 each
  (36% of fork spend) vs $9 under 200k — cold rewrites scale with context, so peak context is
  the number to watch per session (`sessions.py` prints avg + max).
