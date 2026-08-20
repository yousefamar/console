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

/** Cards ready to dispatch: assigned, un-stamped, in a dispatch column. */
export function findDispatchable(board: KanbanBoard): DispatchableCard[] {
  const out: DispatchableCard[] = []
  for (const col of board.columns) {
    if (!DISPATCH_COLUMN_RE.test(col.title)) continue
    col.cards.forEach((card, index) => {
      if (card.agentKey && !card.blockId && !card.checked && !card.blocked) out.push({ column: col.title, index, card })
    })
  }
  return out
}

export interface InFlightCard {
  blockId: string
  agentKey: string | null
  text: string
  column: string
  /** Landed in Under Review — the agent considers it finished. */
  review: boolean
  done: boolean
  blocked: boolean
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
        review: REVIEW_COLUMN_RE.test(col.title),
        done: DONE_COLUMN_RE.test(col.title) || card.checked,
        blocked: card.blocked || BLOCKED_COLUMN_RE.test(col.title),
      })
    }
  }
  return out
}

/** Mint a short block id (Obsidian-style: lowercase alphanumeric). */
export function mintBlockId(random: () => number = Math.random): string {
  let id = ''
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 6; i++) id += chars[Math.floor(random() * chars.length)]
  return id
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
}): string {
  const { boardAbsPath, card, column, project, deployGate } = opts
  const detail = card.lines.slice(1).map((l) => l.trim()).filter(Boolean)
  return [
    '[BOARD TASK — action required]',
    `Board: ${boardAbsPath}${project ? `   Project: ${project}` : ''}`,
    `Card (in "${column}", id ^${card.blockId}):`,
    '',
    card.text,
    ...(detail.length ? ['', ...detail] : []),
    '',
    'This card was assigned to you on the kanban board above. Do the work, then',
    'EDIT THE BOARD FILE to report: move your line under `## Under Review` —',
    'a human (or your manager) checks it and moves it to Done; NEVER move your',
    'own card to Done. If stuck, append a `#blocked` tag to your line (before',
    `the \`^${card.blockId}\` id, which must stay) plus an indented note below it`,
    'explaining what you need — the card keeps its place in the column.',
    'The board file is the single source of truth — there is no other reporting step.',
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

/** Watchdog nudge for a dispatched card that has sat untouched. */
export function buildStaleNudge(opts: { boardAbsPath: string; text: string; blockId: string; minutes: number }): string {
  return [
    `[BOARD TASK — still open after ~${opts.minutes} min]`,
    `Your card "${opts.text}" (^${opts.blockId}) on ${opts.boardAbsPath} is still under In Progress.`,
    'If the work is finished, move the line to `## Under Review`. If stuck, append `#blocked` to it with an indented note. If you are mid-work, keep going — this is just a reminder.',
  ].join('\n')
}
