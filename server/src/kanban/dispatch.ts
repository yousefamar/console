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
  model: string | null
  /** Original card lines (text + indented notes) — a reopen re-dispatch sends
   *  the full envelope, and the accumulated notes ARE the handover. */
  lines: string[]
}

/** Every stamped card and where it currently sits — the whole dispatch state,
 *  derived from the file. Used to seed the in-flight ledger on boot and to
 *  detect completion by diffing consecutive parses. */
export function inFlightCards(board: KanbanBoard): InFlightCard[] {
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
 *  against `taken` (the watcher's global in-flight set is keyed by id alone,
 *  and 48×48 combos make birthday collisions real where 36^6 didn't). Falls
 *  back to a numeric suffix if the random picks keep colliding. */
export function mintBlockId(opts: { taken?: ReadonlySet<string>; random?: () => number } = {}): string {
  const random = opts.random ?? Math.random
  const pick = (list: string[]) => list[Math.floor(random() * list.length)]!
  for (let i = 0; i < 40; i++) {
    const id = `${pick(ID_ADJECTIVES)}-${pick(ID_NOUNS)}`
    if (!opts.taken?.has(id)) return id
  }
  const base = `${pick(ID_ADJECTIVES)}-${pick(ID_NOUNS)}`
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!opts.taken?.has(id)) return id
  }
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
  forkIdentity?: { key: string; sourceKey: string | null } | null
}): string {
  const { boardAbsPath, card, column, project, deployGate, forkIdentity } = opts
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
      '',
    ] : []),
    `Board: ${boardAbsPath}${project ? `   Project: ${project}` : ''}`,
    `Card (in "${column}", id ^${card.blockId}):`,
    '',
    card.text,
    ...(detail.length ? ['', ...detail] : []),
    '',
    'This card was assigned to you on the kanban board above. Do the work, then',
    `report via CLI: \`con spaces board ${project ?? boardAbsPath} move "^${card.blockId}" "Under Review"\` —`,
    'Yousef reviews it and moves it to Done; NEVER move your',
    `own card to Done. If stuck: \`con spaces board ${project ?? boardAbsPath} block "^${card.blockId}" --note "what you need"\``,
    '— the card keeps its place in the column. The board is the single source of',
    'truth; the CLI serializes concurrent edits (never hand-edit the file).',
    'If Yousef comments on your work while the card is Under Review, move it',
    `back to In Progress (\`con spaces board ${project ?? boardAbsPath} move "^${card.blockId}" "In Progress"\`)`,
    'while you address the comment, then return it to Under Review — the board',
    'is his attention queue; Under Review must always mean "ready for Yousef".',
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
      '`autowt cleanup <ticket-slug> -y` only after the merge lands.',
    ] : [
      'WORKTREE: for code work of any substance, isolate yourself first —',
      '`autowt switch <ticket-slug> --terminal echo -y` prints a fresh worktree',
      'path (no terminal opens); do ALL work there, with your own dev server and',
      'tests. When done: fold the work back into the project\'s main branch per',
      'that repo\'s convention (Console: commit lands on `main`, a branch never',
      'survives), then `autowt cleanup <ticket-slug> -y`. Trivial edits (docs,',
      'one-liners) can skip the worktree — your judgment.',
    ]),
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
    'Remove your worktree: `autowt cleanup <ticket-slug> -y`.',
  ] : [
    'Finish the lifecycle NOW:',
    'Verify your work is folded into the project\'s main branch (commit it if anything is still only in your worktree).',
    'Remove your worktree: `autowt cleanup <ticket-slug> -y`.',
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
    'Re-read the card — notes/comments on it explain why. Address them, then move it back to Under Review as usual.',
  ].join('\n')
}

/** Watchdog nudge for a dispatched card that has sat untouched. */
export function buildStaleNudge(opts: { boardAbsPath: string; text: string; blockId: string; minutes: number }): string {
  return [
    `[BOARD TASK — still open after ~${opts.minutes} min]`,
    `Your card "${opts.text}" (^${opts.blockId}) on ${opts.boardAbsPath} is still under In Progress.`,
    'If the work is finished, move the line to `## Under Review`. If stuck, append `#blocked` to it with an indented note. If you are mid-work, keep going — this is just a reminder.',
  ].join('\n')
}
