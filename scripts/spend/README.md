# Spend attribution from Claude Code transcripts

Reads the last 7 days of `~/.claude/projects/*/*.jsonl` and attributes real per-request
`usage` (cache_read / cache_creation / input / output) to what occupied the context.
Ground truth for the token counts is the API's own `usage` field; the split across
context parts is proportional to each part's measured size in the prefix that request read.

- `attribute.py`   — share of spend by context part (Bash output, tool args, system prompt, Read, …)
- `cold-vs-warm.py` — cold (whole prompt rewritten @1.25×) vs warm vs re-read (@0.1×), and what
                     preceded each cold request (TTL lapse / hibernation / >2h wake)
- `ttl-policy.py`  — simulates CLAUDE_CODE_PROMPT_CACHE_TTL 5m vs 1h per session

Gotchas that produced wrong answers the first time (2026-09-08, ^odd-toad):
- Images bill by dimensions (w×h/750, longest edge capped at 1568), NOT by base64 length —
  a char-count proxy overstates a 1920×1080 screenshot 27× (50k vs 1,844 tokens).
- JSONLs log ~40% of assistant requests twice (same `message.id`); dedupe by id or every
  total is inflated and a fake "cold request seconds after the last" bucket appears.
- Char→token proxy (chars/3.7) is only used for the RELATIVE split of a prompt; never sum
  it as an absolute.
Scale the cost-weight shares to the real AWS figure from `GET /dashboard/costs`.
