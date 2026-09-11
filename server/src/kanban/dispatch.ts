// Board-driven delegation — pure logic (no I/O).
//
// The dispatch contract: a card gains `@agentkey` and sits in a dispatch
// column ("In Progress"-like) → the hub stamps a `^blockid` on the line,
// writes the file, and wakes that agent with an envelope naming the board
// file. THE BLOCK ID IS THE DISPATCH MARKER — a card with an id has been
// dispatched; deleting the id re-arms it. No parallel task store: the
// board file carries all state, so a hub restart re-derives everything by
// re-reading boards.
//
// Completion is the agent (or Yousef) moving the line to a done column —
// detected by diffing, not reported via any RPC.

import type { KanbanBoard, BoardCard } from './board.js'
import { skillHintLines, type SkillHint } from './skill-hints.js'

/** Columns whose cards get dispatched when assigned. Deliberately narrow —
 *  an assigned card in Backlog is "planned for X", not "go now". */
export const DISPATCH_COLUMN_RE = /^(in.?progress|doing|active|now)$/i
/** The agent's finish line: work lands here for Yousef/the manager to check.
 *  Only a HUMAN (or the reviewing manager) moves a card on to Done. */
export const REVIEW_COLUMN_RE = /^(under.?review|review|needs.?review)$/i
export const DONE_COLUMN_RE = /^(done|complete|completed|shipped)$/i
/** Legacy Blocked COLUMNS still count as blocked, but the preferred marker is
 *  the `#blocked` tag ON the card (a property — keeps its queue position). */
export const BLOCKED_COLUMN_RE = /^(blocked|waiting|stuck)$/i

/** How many cards may have a live worker at once, machine-wide. Every fork
 *  runs tsc/vitest/eslint in its own worktree, and the worktrees share ONE
 *  spinning disk: 6–9 concurrent forks measured iowait 55–59 %, load 21 on 8
 *  cores and pre-push hooks stretching to 15 min (astera ^lime-kiwi/^pale-yak,
 *  2026-09-03) — at which point `con spaces board` itself times out and the
 *  dispatcher's own writes start failing. Override per hub in prefs
 *  (`boards.maxRunningForks`), per board in frontmatter (`max_forks:`). */
export const DEFAULT_MAX_RUNNING_FORKS = 4

export interface DispatchableCard {
  column: string
  index: number
  card: BoardCard
}

/** Cards ready to dispatch: un-stamped, in a dispatch column. UNASSIGNED
 *  cards are included — the watcher resolves them to the project's default
 *  owner (or leaves them alone when no owner is resolvable). */
export function findDispatchable(board: KanbanBoard): DispatchableCard[] {
  const out: DispatchableCard[] = []
  for (const col of board.columns) {
    if (!DISPATCH_COLUMN_RE.test(col.title)) continue
    col.cards.forEach((card, index) => {
      if (!card.blockId && !card.checked && !card.blocked) out.push({ column: col.title, index, card })
    })
  }
  return out
}

export interface InFlightCard {
  blockId: string
  agentKey: string | null
  text: string
  column: string
  /** Card content (text + detail lines), for change detection: an edit to an
   *  in-flight card should re-notify its assignee — forks don't re-read their
   *  card unprompted, and instructions get added after dispatch. */
  content: string
  /** Landed in Under Review — the agent considers it finished. */
  review: boolean
  done: boolean
  blocked: boolean
  /** Carried so a REOPEN re-dispatch honours the same fork/model choices the
   *  original dispatch would have made. */
  nofork: boolean
  /** `#inherit` (or board `fork_context: inherit`) — the fork gets the
   *  parent's transcript instead of fresh context + digest. */
  inherit: boolean
  model: string | null
  /** Original card lines (text + indented notes) — a reopen re-dispatch sends
   *  the full envelope, and the accumulated notes ARE the handover. */
  lines: string[]
}

/** Every stamped card and where it currently sits — the whole dispatch state,
 *  derived from the file. Used to seed the in-flight ledger on boot and to
 *  detect completion by diffing consecutive parses. */
export function inFlightCards(board: KanbanBoard, opts: { boardInherit?: boolean } = {}): InFlightCard[] {
  const boardInherit = opts.boardInherit ?? false
  const out: InFlightCard[] = []
  for (const col of board.columns) {
    for (const card of col.cards) {
      if (!card.blockId) continue
      out.push({
        blockId: card.blockId,
        agentKey: card.agentKey,
        text: card.text,
        column: col.title,
        content: card.lines.map((l) => l.trim()).join('\n'),
        review: REVIEW_COLUMN_RE.test(col.title),
        done: DONE_COLUMN_RE.test(col.title) || card.checked,
        blocked: card.blocked || BLOCKED_COLUMN_RE.test(col.title),
        nofork: card.nofork,
        inherit: card.inherit || boardInherit,
        model: card.model,
        lines: card.lines,
      })
    }
  }
  return out
}

/** Resolve a project's default owner from its bound roles — the "* general"
 *  convention: one role → it; several → the one whose key/title ends with
 *  "general"; else the first (stable key order). Board frontmatter
 *  `default_owner:` overrides all of this (checked by the caller). Fork and
 *  folder roles never own by default. */
export function resolveDefaultOwner(roles: Array<{ key: string; title: string; fork?: boolean; folder?: boolean }>): string | null {
  const real = roles.filter((r) => !r.fork && !r.folder)
  if (real.length === 0) return null
  if (real.length === 1) return real[0]!.key
  const general = real.find((r) => r.key.endsWith('general') || /\bgeneral$/i.test(r.title))
  if (general) return general.key
  return [...real].sort((a, b) => a.key.localeCompare(b.key))[0]!.key
}

// Readable block ids: `bold-fox` beats `p2asvl` — the id lands in fork
// titles/agentKeys ("Console general ^bold-fox (fork)"), so Yousef tracks
// tickets by name, not by six random glyphs. Obsidian block-ref grammar
// allows dashes, so these are still valid ^ids. Words kept ≤5 chars.
const ID_ADJECTIVES = [
  'able', 'bold', 'blue', 'brisk', 'busy', 'calm', 'cool', 'cosy', 'deft', 'dry',
  'fond', 'glad', 'gold', 'gray', 'green', 'hazy', 'jade', 'keen', 'kind', 'lean',
  'loud', 'lime', 'mild', 'neat', 'odd', 'pale', 'pink', 'plum', 'prim', 'quick',
  'rare', 'red', 'ripe', 'rosy', 'shy', 'sly', 'snug', 'soft', 'spry', 'tall',
  'tame', 'teal', 'tidy', 'trim', 'warm', 'wavy', 'wise', 'zany',
]
const ID_NOUNS = [
  'ant', 'bass', 'bat', 'bear', 'bee', 'boar', 'carp', 'colt', 'crab', 'crow',
  'deer', 'dove', 'duck', 'eel', 'elk', 'fawn', 'finch', 'fox', 'frog', 'goat',
  'gull', 'hare', 'hawk', 'heron', 'ibis', 'kite', 'kiwi', 'koi', 'lark', 'loon',
  'lynx', 'mole', 'moth', 'newt', 'orca', 'otter', 'owl', 'pony', 'ram', 'seal',
  'stag', 'swan', 'tern', 'toad', 'vole', 'wolf', 'wren', 'yak',
]

/** Mint a short, READABLE block id — `<adjective>-<animal>`, collision-checked
 *  against `taken` (a set, or a predicate that can also consult things outside
 *  the boards — fork sessions carry the id in their key and title). 48×48
 *  combos make birthday collisions real where 36^6 didn't: with ~250 ids in
 *  use a blind pick clashes ~10 % of the time, and a clash is not cosmetic —
 *  the in-flight ledger, the wind-down lookup and the reopen peel are all
 *  keyed by id alone (astera ^gray-stag/^spry-kite, 2026-09-09: the fork got
 *  alternating approve/reopen wakes meant for an old Done card). Falls back
 *  to a numeric suffix if the random picks keep colliding. */
export function mintBlockId(opts: { taken?: ReadonlySet<string> | ((id: string) => boolean); random?: () => number } = {}): string {
  const random = opts.random ?? Math.random
  const pick = (list: string[]) => list[Math.floor(random() * list.length)]!
  const given = opts.taken
  const taken = typeof given === 'function' ? given : (id: string) => given?.has(id) ?? false
  for (let i = 0; i < 40; i++) {
    const id = `${pick(ID_ADJECTIVES)}-${pick(ID_NOUNS)}`
    if (!taken(id)) return id
  }
  const base = `${pick(ID_ADJECTIVES)}-${pick(ID_NOUNS)}`
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken(id)) return id
  }
}

/** A ticket-fork's session title — just the readable id ("Gold finch (fork)");
 *  the parent is visible via indent/filter. One definition, so the clash check
 *  at mint time and the fork spawn can't disagree about the shape. */
export function forkTitle(blockId: string): string {
  return `${blockId.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} (fork)`
}

/** Does a session's key or title already carry this ticket id? The key shape
 *  is `<source>-<id>-fork` (load-bearing: wind-down and reopen peel it), the
 *  title is `forkTitle(id)`. Ended sessions count too — `con agent chat` by
 *  name and the SPA's session list would still show two "Gold finch (fork)". */
export function sessionCarriesBlockId(s: { agentKey?: string | null; name?: string | null }, blockId: string): boolean {
  return !!s.agentKey?.endsWith(`-${blockId}-fork`) || s.name === forkTitle(blockId)
}

// ─── Hand-back: what Yousef actually reads ───────────────────────────────
// He reviews from the CARD (Spaces board / Inbox hand-back strip), not the
// transcript, and often days later — so the card must carry a concise
// bulleted record of what was done, plus screenshots when the work is hard
// to check by hand (worktree builds he never ran, UI he hasn't seen). All
// the wording lives here so the envelope, the protocol stanza, the CLI
// warning and the review-feedback reminder can't drift.

/** The hand-back summary convention: `- ` bullet detail lines on the card. */
export function hasSummaryBullets(detail: string[]): boolean {
  return detail.some((l) => /^- /.test(l))
}

/** `con spaces board <ref>` — a project slug when known, else the board path
 *  (the CLI accepts a vault-relative .md path too). */
function boardRef(project: string | null | undefined, boardPath: string): string {
  return project ?? boardPath
}

export function handbackStanza(ref: string, blockId: string): string[] {
  return [
    'HAND-BACK (Yousef reads the CARD, not your transcript — often days later):',
    `1. \`con spaces board ${ref} note "^${blockId}" "- …"\` — a concise bulleted summary of EXACTLY what you did: what changed (files/commands/commits), how you verified it, anything he must know or decide. One \`- \` bullet per line; newlines are fine.`,
    `2. \`con spaces board ${ref} attach "^${blockId}" <screenshot.png> [--caption "…"]\` — screenshots wherever a visual check helps. REQUIRED when you worked in a worktree or touched UI: he can't easily run your worktree, so show him (capture your own dev server via Playwright/grim — never his live tab).`,
    `3. Only THEN \`con spaces board ${ref} move "^${blockId}" "Under Review"\`. Finish your turn with the same bullets as your final message.`,
  ]
}

/** Returned by BoardOps.move when a card enters Under Review with no summary. */
export function handbackWarning(ref: string, blockId: string | null): string {
  const id = blockId ?? 'id'
  return `no hand-back summary on this card — add one now: \`con spaces board ${ref} note "^${id}" "- what changed …"\` (one \`- \` bullet per line, newlines OK), plus \`con spaces board ${ref} attach "^${id}" <screenshot.png>\` if you worked in a worktree or touched UI. Yousef reads the card, not your transcript.`
}

export interface ReviewCardRef {
  blockId: string
  text: string
  boardPath: string
  project: string | null
}

/** Appended (stdin-only) to a human message reaching a session that owns
 *  Under-Review cards: agents routinely forgot that feedback = the card goes
 *  BACK to In Progress, so the rule is restated at the exact moment it
 *  applies rather than only in the long-scrolled-away dispatch envelope. */
export function buildReviewReminder(cards: ReviewCardRef[]): string {
  if (cards.length === 0) return ''
  const list = cards.map((c) => `  • "${c.text}" (^${c.blockId}) — \`con spaces board ${boardRef(c.project, c.boardPath)} move "^${c.blockId}" "In Progress"\``)
  return [
    '',
    '---',
    `[BOARD — you own ${cards.length === 1 ? 'a card' : `${cards.length} cards`} in Under Review]`,
    ...list,
    'If the message above is Yousef\'s feedback on that card, it is MORE WORK and the card is no longer ready: FIRST move it back to In Progress (command above), do the work, then `note` a fresh `- ` bulleted summary (+ `attach` screenshots if visual) and move it to "Under Review" again. Under Review must only ever mean "ready for Yousef". If the message is unrelated to the card, ignore this note.',
  ].join('\n')
}

/** Stdin-only reminder appended to a human message reaching a session whose
 *  `@key` owns a `#blocked` card: a `#blocked` card means "stuck on Yousef",
 *  so his message is usually the unblock — and the fork must clear the tag,
 *  or the Inbox keeps the row red (blocked AND unread) on every reply. */
export function buildBlockedReminder(cards: ReviewCardRef[]): string {
  if (cards.length === 0) return ''
  const list = cards.map((c) => `  • "${c.text}" (^${c.blockId}) — \`con spaces board ${boardRef(c.project, c.boardPath)} unblock "^${c.blockId}"\``)
  return [
    '',
    '---',
    `[BOARD — you own ${cards.length === 1 ? 'a #blocked card' : `${cards.length} #blocked cards`}]`,
    ...list,
    'If the message above gives you what you were waiting for, FIRST run the unblock command above (the tag means "stuck on Yousef" and keeps the card red in his Inbox until cleared), then continue the work. If you are still blocked after reading it, leave the tag and `note` what is still missing.',
  ].join('\n')
}

/** The wake envelope injected into the assignee's session. Self-instructing:
 *  the board FILE is the reporting surface, no RPC to learn. */
export function buildBoardEnvelope(opts: {
  boardAbsPath: string
  card: { text: string; blockId: string; lines: string[] }
  column: string
  project?: string | null
  /** Board frontmatter `deploy_gate: review` — merging to main IS deploying
   *  (auto-deploy repos), so work stays on its branch until card approval. */
  deployGate?: 'review' | null
  /** The worker is a fresh TICKET-FORK whose @key differs from the source
   *  role it inherited its context (and self-identity prompt) from. Without
   *  this the fork reads the reassigned board line, believes it's still the
   *  source role, and STANDS DOWN from its own card ("a dedicated fork owns
   *  this") — observed live 2026-08-20. */
  forkIdentity?: {
    key: string
    sourceKey: string | null
    /** The fork's hub-minted csid (pinned via `--session-id`). Named in the
     *  envelope so the reader can PROVE it is the addressee from its own
     *  argv — an inherited transcript is full of the parent's "I am <csid>"
     *  claims, and a mis-routed or twin-delivered wake should be loud, not
     *  silently worked (^blue-vole). */
    claudeSessionId?: string | null
    /** `inherited` = spawned with `--fork-session` (argv also carries the
     *  parent's `--resume`); `fresh` (default since ^tall-colt) = a new
     *  session that knows the parent only through `parentDigest`. */
    context?: 'fresh' | 'inherited'
  } | null
  /** Fresh-context forks: what the parent knows that matters for this card,
   *  as a compact digest (buildParentDigest) — CLAUDE.md and auto-memory
   *  arrive natively via the cwd, so this carries only the conversation. */
  parentDigest?: string | null
  /** How many cards (including this one) now have a live worker, and the cap.
   *  Every worktree lives on the same disk, so a fork starting under load must
   *  serialise its heavy steps instead of adding a parallel tsc/vitest. */
  load?: { running: number; cap: number } | null
  /** Project skills the card plausibly touches (skill-hints.ts) — named so the
   *  fork reads the SKILL.md before its first edit; `paths:`-scoped skills
   *  aren't in its listing until then. */
  skills?: readonly SkillHint[] | null
}): string {
  const { boardAbsPath, card, column, project, deployGate, forkIdentity, load, parentDigest, skills } = opts
  const inherited = forkIdentity?.context !== 'fresh'
  // Image detail lines are delivered as REAL image attachments on the wake —
  // echoing them as text renders a broken ![img] box in the transcript.
  const detail = card.lines.slice(1).map((l) => l.trim())
    .filter((l) => l && !/^!\[[^\]]*\]\([^)]+\)$/.test(l))
  return [
    '[BOARD TASK — action required]',
    ...(forkIdentity ? [
      `IDENTITY: YOU are the dedicated fork for this card. Your agentKey is now \`${forkIdentity.key}\`` +
      (forkIdentity.sourceKey ? ` (no longer \`${forkIdentity.sourceKey}\` — your system prompt predates the fork)` : '') +
      `. The board line's \`@${forkIdentity.key}\` means YOU. Do not stand down or defer to "the fork" — you ARE it.`,
      ...(forkIdentity.claudeSessionId ? [
        `Your claudeSessionId is \`${forkIdentity.claudeSessionId}\` — your own process argv carries \`--session-id ${forkIdentity.claudeSessionId}\` (\`ps -o args= -p $PPID\`)` +
        (inherited
          ? `; the \`--resume\` id beside it is your PARENT's, not yours.`
          : ` and NO \`--resume\`/\`--fork-session\` — you are a fresh session, not a transcript copy; your parent's context reaches you only as the digest below.`) +
        ' If your argv does NOT carry this --session-id, this wake reached the wrong process: do not work the card — say so and stop.',
      ] : []),
      '',
    ] : []),
    ...(parentDigest ? [
      'CONTEXT FROM YOUR PARENT (a digest, not a transcript — CLAUDE.md and auto-memory you already have natively):',
      parentDigest,
      '',
    ] : []),
    `Board: ${boardAbsPath}${project ? `   Project: ${project}` : ''}`,
    `Card (in "${column}", id ^${card.blockId}):`,
    '',
    card.text,
    ...(detail.length ? ['', ...detail] : []),
    '',
    ...skillHintLines(skills ?? []),
    'This card was assigned to you on the kanban board above. Do the work, then',
    'hand it back via the CLI — Yousef reviews the card and moves it to Done; NEVER move your',
    `own card to Done. If stuck: \`con spaces board ${project ?? boardAbsPath} block "^${card.blockId}" --note "what you need"\``,
    '— the card keeps its place in the column. The board is the single source of',
    'truth; the CLI serializes concurrent edits (never hand-edit the file).',
    '',
    ...handbackStanza(project ?? boardAbsPath, card.blockId),
    '',
    'FEEDBACK RE-OPENS THE CARD: any comment Yousef sends you while the card sits in',
    `Under Review means more work — FIRST \`con spaces board ${project ?? boardAbsPath} move "^${card.blockId}" "In Progress"\`,`,
    'then address it, then note a fresh summary and return it to Under Review. The board',
    'is his attention queue; Under Review must only ever mean "ready for Yousef".',
    '',
    // GOTCHA: the gated/ungated stanzas share no text — an edit to the
    // worktree instructions must be made in BOTH branches or they drift.
    ...(deployGate === 'review' ? [
      'DEPLOY GATE (this board sets `deploy_gate: review` — merging to main',
      'DEPLOYS): do NOT merge to main. Work on a branch in your worktree',
      '(`autowt switch <ticket-slug> --terminal echo -y` prints the path), PUSH',
      'THE BRANCH, and when moving the card to Under Review add an indented',
      'note with the branch name + the preview URL (e.g. the Vercel branch',
      'preview). The merge to main happens only after the card owner approves —',
      'they merge, or tell you to. Keep the worktree until then;',
      'remove it only after the merge lands: `git worktree remove <path> &&',
      'git branch -d <branch>` (never `autowt cleanup --mode …` — it sweeps',
      'EVERY merged worktree, siblings included; `autowt cleanup <slug> -y`',
      'needs a TTY you do not have).',
    ] : [
      'WORKTREE: for code work of any substance, isolate yourself first —',
      '`autowt switch <ticket-slug> --terminal echo -y` prints a fresh worktree',
      'path (no terminal opens); do ALL work there, with your own dev server and',
      'tests. When done: fold the work back into the project\'s main branch per',
      'that repo\'s convention (Console: commit lands on `main`, a branch never',
      'survives), then remove YOUR worktree only: `git worktree remove <path>',
      '&& git branch -d <branch>` — never `autowt cleanup --mode …` (sweeps',
      'every merged worktree, siblings included) and `autowt cleanup <slug> -y`',
      'needs a TTY you do not have. Trivial edits (docs, one-liners) can skip',
      'the worktree — your judgment.',
    ]),
    ...(load && load.running > 1 ? [
      '',
      `LOAD: ${load.running} of a maximum ${load.cap} cards are being worked right now, and every`,
      'worktree is on the SAME disk. Run heavy steps (typecheck, tests, lint,',
      'builds, install) through the repo\'s serialising wrapper if it has one',
      '(`pnpm heavy <cmd>` / `scripts/heavy.sh`), or one at a time — do not fan',
      'them out in parallel. A saturated disk stalls every other fork AND the',
      'hub\'s own board writes.',
    ] : []),
  ].join('\n')
}

/** Done wind-down for a ticket-fork: Yousef approved the card — finish the
 *  lifecycle. Gated boards: approval IS the merge signal (merging deploys).
 *  Ungated: work should already be on main; verify, then clean up. The fork's
 *  turn-end triggers the hub's merge-back + self-destruct — no action needed
 *  from the fork beyond this checklist. */
export function buildWindDownEnvelope(opts: {
  boardAbsPath: string
  text: string
  blockId: string
  deployGate: 'review' | null
}): string {
  const [header, ...steps] = opts.deployGate === 'review' ? [
    'This board is deploy-gated: approval IS the merge signal. NOW:',
    'Merge your branch into main (this deploys) — resolve conflicts if any.',
    'Verify the merge landed (git log on main).',
    'Remove YOUR worktree only: `git worktree remove <path> && git branch -d <branch>` (never `autowt cleanup --mode …`; `-y` needs a TTY you do not have).',
  ] : [
    'Finish the lifecycle NOW:',
    'Verify your work is folded into the project\'s main branch (commit it if anything is still only in your worktree).',
    'Remove YOUR worktree only: `git worktree remove <path> && git branch -d <branch>` (never `autowt cleanup --mode …`; `-y` needs a TTY you do not have).',
  ]
  steps.push(
    'Make any learnings durable IF NEEDED: non-obvious gotchas, architecture decisions, or new wiring from this card belong in the repo\'s CLAUDE.md / project docs / your auto-memory — a fork\'s context dies with it, so anything only in your head is lost. Skip if nothing qualifies.',
    'End your turn with a one-line confirmation.',
  )
  return [
    `[CARD APPROVED — wind down] "${opts.text}" (^${opts.blockId}) was moved to Done on ${opts.boardAbsPath}.`,
    '',
    header!,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    'When this turn ends, the hub automatically merges your summary into your parent session and closes you — do not do that yourself, and do not start new work.',
  ].join('\n')
}

/** A card the assignee finished (or parked) is back in a dispatch column and
 *  the assignee is still alive — tell it to pick the card back up. The dead-
 *  assignee case gets a full re-dispatch envelope instead. */
export function buildReopenNudge(opts: { boardAbsPath: string; text: string; blockId: string; column: string }): string {
  return [
    `[BOARD TASK — reopened] Your card "${opts.text}" (^${opts.blockId}) on ${opts.boardAbsPath} is back in "${opts.column}".`,
    'Re-read the card — notes/comments on it explain why. Address them, then hand back as usual: `note` a fresh `- ` bulleted summary of what changed this round (+ `attach` screenshots if visual), then move it to Under Review.',
  ].join('\n')
}

/** Prefs `boards.compactForksOnSpawn` default: a ticket-fork's FIRST turn is a
 *  `/compact`, the card envelope is queued behind it. A `--fork-session` child
 *  inherits the source's whole transcript (~70k tokens of it at first request,
 *  fleet median, 2026-09-08) and re-reads it on every one of its ~490 requests
 *  — 24 % of all cache_read spend. The CLI's own tool-result clearing is REPL +
 *  first-party only, so compaction is the lever we have (^brisk-wolf). */
export const DEFAULT_COMPACT_FORKS_ON_SPAWN = true

/** The `/compact <focus>` sent as a ticket-fork's first message. Slash
 *  commands work over stream-json (verified 2026-09-08: 40k → 1.2k tokens,
 *  ~11 s, `system/compact_boundary trigger:manual` then a `result`). The
 *  focus tells the summariser what a fresh card worker actually needs — the
 *  project's CLAUDE.md is in the system prompt regardless. */
export function buildForkCompactPrompt(): string {
  return '/compact You are being forked to work ONE kanban card. Keep: who you are (agentKey, cwd, project, repo), the project\'s standing rules, decisions and gotchas that are NOT already in CLAUDE.md, and the current state of the code/fleet a new task would need. Drop: tool outputs, past hand-back and merge reports, and chatter about other cards.'
}

/** Watchdog nudge for a dispatched card that has sat untouched. */
export function buildStaleNudge(opts: { boardAbsPath: string; text: string; blockId: string; minutes: number }): string {
  return [
    `[BOARD TASK — still open after ~${opts.minutes} min]`,
    `Your card "${opts.text}" (^${opts.blockId}) on ${opts.boardAbsPath} is still under In Progress.`,
    'If the work is finished, move the line to `## Under Review`. If stuck, append `#blocked` to it with an indented note. If you are mid-work, keep going — this is just a reminder.',
  ].join('\n')
}
