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
