// Approving a review hand-back from the Inbox = moving the agent's Under
// Review card(s) to the board's Done column. Shared by the viewer's
// "Approve → Done" strip and the `e` key on an agent row, so both surfaces
// mean the same thing.

import type { ReviewHandback } from '@/inbox/route'

export type CardMover = (project: string, query: string, toColumn: string) => Promise<void>

export interface ApproveOutcome {
  /** Hand-backs actually moved to Done. */
  moved: ReviewHandback[]
  /** Hand-backs whose board has no Done column — nothing to move them to. */
  skipped: ReviewHandback[]
  /** First failure, if a move threw; later hand-backs are left untouched. */
  error?: { handback: ReviewHandback; cause: unknown }
}

/** Move every approvable hand-back to Done, in order, stopping at the first
 *  failure (a half-approved batch is visible on the board; a silently
 *  swallowed error is not). */
export async function approveHandbacks(handbacks: ReadonlyArray<ReviewHandback>, move: CardMover): Promise<ApproveOutcome> {
  const out: ApproveOutcome = { moved: [], skipped: [] }
  for (const h of handbacks) {
    if (!h.doneColumn) { out.skipped.push(h); continue }
    try {
      await move(h.project, h.query, h.doneColumn)
      out.moved.push(h)
    } catch (cause) {
      out.error = { handback: h, cause }
      break
    }
  }
  return out
}

/** Hub errors arrive as a JSON `{error}` body inside the thrown message. */
export function hubErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  try {
    const j = JSON.parse(m) as { error?: unknown }
    if (typeof j?.error === 'string') return j.error
  } catch { /* not JSON */ }
  return m
}
