---
name: ticket-forks
description: How a board card becomes a worker session — the ticket-fork lifecycle: forkRoleSessionForTicket (fresh-context default vs `#inherit` transcript copy, the hub-minted `--session-id` pin, key shape `<sourceKey>-<id>-fork`, lineage), the parent digest in the envelope (kanban/fork-digest.ts), /compact-first wake for inherited forks, the 1h prompt-cache pin, the fork-cost ledger + `con agent fork-cost` (cache_read per turn by mode), wind-down + merge-into-parent. Read before changing dispatch, fork spawning, the envelope, or fork identity/cost accounting.
paths: server/src/kanban/dispatch.ts, server/src/kanban/fork-digest.ts, server/src/agents/fork-cost.ts, server/src/agents/merge.ts, server/src/routes/agents.ts
user-invocable: false
metadata:
  card_keywords: "ticket-fork, ticket fork, fork context, fresh-context, #inherit, fork_context, parent digest, fork-cost, fork cost, cache_read per turn, --fork-session, forkRoleSessionForTicket, wind-down envelope, merge into parent"
---

# Ticket-forks — from board card to worker session

Cross-cutting rules stay in `CLAUDE.md` → "Board-driven delegation"; this file is the mechanics. Keep it current in the same commit as the code.

## Spawn: fresh by default, `#inherit` for the transcript copy

`forkRoleSessionForTicket(ctx, source, blockId, model, { inherit })` (`routes/agents.ts`) mints the worker for a dispatched card. Two modes, identical in everything but the transcript:

- **Fresh (default).** `createSession` with `pinSessionId: true`, `forkContext: 'fresh'`, no `resume`. `Session` pre-mints a csid (`randomUUID`) and `spawn()` passes `--session-id <own>` alone — the id is in the manifest and `list_sessions` from birth and the process argv names itself. The fork runs at the **parent's cwd**, so CLAUDE.md, the project-board pointer and **auto-memory** (memory dir is pinned per cwd) arrive through the normal keyed-spawn injection in `createSession`. What it does NOT have is the parent's conversation — that comes as the digest (below).
- **Inherited (`#inherit` card token or board frontmatter `fork_context: inherit`).** `resume: source.claudeSessionId, fork: true, forkContext: 'inherited'` → `--resume <parent> --fork-session --session-id <own>`: the CLI copies the parent's whole transcript. The dispatcher then wakes it `/compact`-first (`wakeForkCompacted`, pref `boards.compactForksOnSpawn`, default on) with the envelope queued behind the compaction; a fresh fork skips that step — nothing to compact. Use it for "continue what we discussed" cards only: an inherited Console-general fork re-read ~130k tokens per message.

Shared by both modes: fork key = `mintAgentKey('<source.agentKey> <blockId> fork')` (the **key**, not the name — `rootOf()` in the SPA and the reopen peel-back strip `-<id>-fork` and expect the source key); `parentClaudeSessionId = source.claudeSessionId`; `project`/`areas` inherited (same space); title `"<Block id> (fork)"`; `cacheTtl: '1h'` pinned for the fork's life; `#model/<alias>` (or bare `#haiku`/`#sonnet`/`#opus`/`#fable`) → `modelOverride`. The board line is rewritten to `@<forkKey>` by the watcher (string return from `onDispatch`), so stale nudges, transition wakes and the review reminder all target the fork.

`BoardDispatch.inherit` and `InFlightCard.inherit` (card tag OR board frontmatter, resolved in `watcher.ts`) carry the choice so a **reopen** re-dispatch (`onReopen` in `index.ts`) spawns the same kind of fork. Toggle surfaces: `con spaces board <p> inherit|fresh "^id"` → `POST /board/:project/inherit {card, inherit}` → `BoardOps.setInherit`; SPA modal pill `⧉ inherit/fresh` + tile badge (`useSpacesStore.toggleInherit`); the parser handles `#inherit` in both ports (`server/src/kanban/board.ts`, `src/kanban/board.ts`) and `sanitizeCardText` backtick-wraps a colliding tail.

## Envelope: identity + digest

`buildBoardEnvelope` (`kanban/dispatch.ts`) renders, for a fork, an IDENTITY stanza naming the fork key and its csid with an argv self-check (`ps -o args= -p $PPID` must show `--session-id <csid>`; `forkIdentity.context` decides the wording — inherited: "the `--resume` beside it is your PARENT's"; fresh: "NO `--resume`/`--fork-session` — you are a fresh session"). A wake that reaches the wrong process must say so and stop (twin-delivery class).

For fresh forks `parentDigest` follows the identity block as `CONTEXT FROM YOUR PARENT (a digest, not a transcript …)`. `buildParentDigest(parent.messageLog, { parent, todos })` in `kanban/fork-digest.ts` is a **template, not a model call** (zero latency in the dispatch path): an identity line (parent name/@key/cwd — "its CLAUDE.md and auto-memory are yours"), the parent's open plan items (`SessionInfo.todos`, non-completed), then the last ≤8 **human** exchanges oldest-first — each Yousef prompt (≤600 chars) with the first assistant `text` that followed (≤400 chars). `isMachinePrompt` drops anything starting `[` or `/` (board envelopes, merge hand-backs, cron wakes, nudges — most of a Console parent's log). Hard cap ~8k chars; oldest exchanges are dropped first, the identity/plan lines never. `null` when nothing qualifies (no section rendered). If the template proves too thin, the seam is `parentDigestFor()` in `index.ts` — swap in a cheap-model summary there, not in the envelope builder.

## Measurement: is fresh actually cheaper?

`Session.forkContext` (`'fresh' | 'inherited'`, manifest-persisted, on `SessionInfo`) and `Session.turnCount` (completed `result`s). When a fork session **ends** (`exit` with `status === 'ended'` in `createSession` — merge, kill, self-destruct; never hibernation) `ForkCostLedger.record()` appends `{ts, agentKey, name, claudeSessionId, context, turns, tokens, cost, lifeMs}` to `~/.config/console/fork-cost.jsonl` (`agents/fork-cost.ts`). `GET /agents/fork-cost[?days=N]` / `con agent fork-cost [--days 7]` → `aggregate()` folds ended records with live forks into one bucket per mode: sessions, turns, cacheRead, cacheCreation, input, output, cost, **cacheReadPerTurn**, costPerTurn. Forks spawned before the ledger existed report `unknown`. Compare `fresh` vs `inherited` cacheReadPerTurn after a week; per-turn is the right unit because `result.usage` is per turn and `cache_read_input_tokens` is exactly the re-read cost.

## Identity rules that changed

- "`--fork-session` present ⇒ fork" is now only true for `#inherit` forks. A fresh fork's argv carries `--session-id <own>` and no `--resume`; `con agent list` shows its `parentClaudeSessionId` and `forkContext`. The reaper (`process-reaper.ts` `csidRefs`) matches `--session-id`, so fresh forks are owned/reaped like any session.
- The init handler treats a pre-set csid that differs from the CLI's as a re-key; a pinned fresh spawn whose pin was ignored logs `csid pin ignored by the CLI` (same path as an ignored fork pin).

## Wind-down and merge (unchanged by the context mode)

Done on a fork's card → `buildWindDownEnvelope` (gated vs ungated steps) → the fork's turn-end triggers `mergeIntoParent` (`captureNextTurn` + `buildMergeRequest`/`buildMergeEnvelope` in `agents/merge.ts`): the fork self-summarises, the digest is injected into the parent as a `[MERGE — fork …]` prompt, active hub crons re-key onto the parent (`ctx.reassignCron`), the fork is killed. Fresh forks summarise exactly what they did; nothing about the parent's history leaks back because they never had it.

## Tests

`kanban.test.ts` (`#inherit` token, `boardForkContext`), `kanban-dispatch.test.ts` (envelope variants, watcher `inherit` propagation into dispatch + in-flight ledger), `fork-digest.test.ts`, `fork-cost.test.ts`, `session.test.ts` (pinned fresh spawn argv, `turnCount`), `delegation-spawn.test.ts` (fresh vs inherit spawn options, key shape).
