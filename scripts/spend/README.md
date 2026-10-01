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
- `effort.py`     — over an extract: output-token $ by session KIND (fork / cronFork / listenerFork /
                     chatFork / default, inferred from the hub's wake envelopes) × `--effort`. The
                     before/after check for the per-kind effort policy (^busy-elk): 22–28 Sep baseline
                     = fork $453/wk (64% of requests), chatFork $13, default $237 — all xhigh.
- `clear-sim.py`  — replays every request with its running transcript composition and prices
                     tool-result clearing policies against stock: the API's `clear_tool_uses` as
                     measured on Bedrock (frozen set while the cache lives, re-clear on cold),
                     proxy-side cold-only and hybrid; `--keep N --inputs --exclude Read,Edit`.
                     Honours Claude Code compaction boundaries (`isCompactSummary`); sidechains stock-only
- `context-probe.ts` — (tsx) grows a synthetic tool-use conversation against Bedrock one exchange
                     at a time and prints usage + `applied_edits` per call — how the API's
                     context editing really behaves (`--clear --trigger --keep --force-at 12,19
                     --infill 6000 --thinking-edit --model haiku|fable`); same signer + eventstream
                     parser as the hub's context proxy (`server/src/agents/context-proxy.ts`)

Context-editing findings (2026-10-01 ^plum-fawn): stale tool results beyond the last 3 tool uses are
37 % of input spend; the API clears ALL but `keep` when the retained prompt crosses `trigger`, then
FREEZES that set while a cached copy exists (warm), and re-clears from scratch when the retained
prompt exceeds the trigger again (a cold write of the retained prompt). A trigger below the uncleared
floor therefore rewrites every request (+1000 % in the sim) — the hub proxy steers the trigger per
request instead (CLAUDE.md → Context proxy). Clearing only at cold moments: results −30 %, results +
inputs −46 % of input spend; keep 3 vs 10 is within 2 points. The proxy ledger
(`~/.config/console/context-proxy.jsonl`) is the ground truth for the live canary.

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
- CORRECTED 2026-10-01 (^spry-bear): the ~1% "whole history rewritten with the system prefix still
  cached" pattern that appeared 2026-09-22 was NOT the Stripe remote-MCP plugin installed that
  evening — it is CLI 2.1.280 (symlink moved 22 Sep 22:11 UTC): the SECOND request after a
  spawn/resume is a full rewrite 22% of the time (2.1.263: 1.9%), same on 5m and 1h TTL, rate
  rising with the req1→req2 delay. Split by the per-line `version` field and by the day
  `~/.local/bin/claude` changed BEFORE blaming TTL, plugins or MCP flapping. Detector in
  extract.py's ledger: cold (cr<60k, cw>100k) followed within 10 min by cr<60k, cw>0.7× the first.
