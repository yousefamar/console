// Moving a LIVE session onto forge.
//
// Placement used to be decided once, at spawn, and never again — so every
// session that started before the box was an option, or whose card was fired
// while the box was cold, stayed on the desktop for its whole life. That was
// the answer to "why are so many agents still running locally": not a policy,
// just the absence of a way to change your mind.
//
// A move is four things in order, and the order matters:
//   1. the box, the mounts, the repo and a dev port  (prepareRemoteSession)
//   2. the TRANSCRIPT, pushed desktop → forge   — without it `--resume` on the
//      box finds nothing and the conversation is silently restarted
//   3. the fork's WORKTREE, branch plus uncommitted changes, at the same path
//   4. the placement flip, which puts the process down; the next message
//      resumes it on forge with its history and its working tree intact
//
// Every step reports its own failure and the move stops there, leaving the
// session exactly where it was. A half-moved session is the one outcome worth
// going out of our way to avoid.

import { forgeConfig } from './config.js'
import { prepareRemoteSession, repoForCwd } from './index.js'
import { pushTranscript } from './transcripts.js'
import { ensureWorktreeOnForge, localWorktrees } from './repo.js'

/** What a move needs of a Session, structurally — forge/ must not import
 *  session.ts (session.ts imports this package). */
export interface MoveTarget {
  id: string
  name?: string
  agentKey?: string
  cwd: string
  claudeSessionId: string | null
  placement: 'local' | 'forge'
  /** True while a turn is in flight: the move is applied at turn end instead. */
  busy: boolean
  /** Put the process down and record the new placement. The next message
   *  resumes there. */
  applyPlacement(placement: 'local' | 'forge', devPort: number | null): { ok: boolean; error?: string }
  /** Run `fn` when the current turn finishes. */
  afterTurn(fn: () => void): void
}

export interface MoveResult {
  session: string
  ok: boolean
  reason: string
  devPort?: number | null
  /** True when the move was accepted but applies when the current turn ends. */
  deferred?: boolean
  worktrees?: string[]
}

/** Worktrees on the desktop that belong to this session.
 *
 *  A card fork's branch is named after its card (`autowt switch <blockId>`,
 *  astera's `card/<blockId>-<slug>`), and its agentKey carries the same
 *  blockId — so the blockId is the join. A session with no matching worktree is
 *  not an error: plenty of forks work in the primary checkout. */
export function blockIdFromAgentKey(agentKey: string | undefined | null): string | null {
  return agentKey?.match(/-([a-z]+-[a-z]+)-fork$/)?.[1] ?? null
}

export async function worktreesForSession(localRepoPath: string, agentKey: string | undefined): Promise<Array<{ path: string; branch: string }>> {
  const blockId = blockIdFromAgentKey(agentKey)
  if (!blockId) return []
  const all = await localWorktrees(localRepoPath)
  return all.filter((w) => w.path.includes(blockId) || w.branch.includes(blockId))
}

export async function moveSessionToForge(
  target: MoveTarget,
  log: (m: string) => void = () => {},
  /** Where a DEFERRED move's eventual verdict goes. The CLI call has already
   *  returned by then, so without this a mid-turn move that fails at turn end
   *  is invisible and the mover believes the session is on forge. */
  report: (r: MoveResult) => void = () => {},
): Promise<MoveResult> {
  const label = target.name ?? target.id
  if (!forgeConfig()) return { session: label, ok: false, reason: 'forge is not configured' }
  if (target.placement === 'forge') return { session: label, ok: false, reason: 'already on forge' }
  if (!target.claudeSessionId) {
    return { session: label, ok: false, reason: 'no claudeSessionId yet — nothing to resume on forge; let it finish a turn first' }
  }

  if (target.busy) {
    // Mid-turn: do none of the work now. Everything below reads state the turn
    // is actively changing (the transcript grows, the worktree churns), so the
    // only correct time is after the result message.
    pending.add(target.id, label, report)
    target.afterTurn(() => {
      pending.clear(target.id)
      void performMove(target, log)
        .then(report)
        .catch((err: unknown) => report({ session: label, ok: false, reason: `deferred move threw: ${(err as Error).message}` }))
    })
    return { session: label, ok: true, deferred: true, reason: 'mid-turn — the move applies when this turn ends' }
  }
  return performMove(target, log)
}

/** Deferred moves accepted but not yet run.
 *
 *  A deferred move lives entirely in one in-memory `afterTurn` callback, so a
 *  hub restart between the accept and the turn's end drops it with nothing
 *  said — the same silent hole `report` closed for a failing move, reached
 *  through a different door. Seen for real: a move accepted shortly before the
 *  08:46 restart on 8 Oct 2026 was discarded, and `con agent forge status`
 *  then showed the session local with no record that a move had been promised.
 *  Shutdown drains this and reports each one as the failure it is. */
export class PendingMoves {
  private entries = new Map<string, { label: string; report: (r: MoveResult) => void }>()

  add(id: string, label: string, report: (r: MoveResult) => void): void {
    this.entries.set(id, { label, report })
  }

  clear(id: string): void {
    this.entries.delete(id)
  }

  /** Tell every waiting mover the move is not going to happen, and forget them. */
  drain(reason: string): MoveResult[] {
    const out: MoveResult[] = []
    for (const { label, report } of this.entries.values()) {
      const r: MoveResult = { session: label, ok: false, reason }
      out.push(r)
      // Shutdown is best-effort and time-boxed; one throwing reporter must not
      // stop the rest from being told.
      try { report(r) } catch { /* nothing useful to do here */ }
    }
    this.entries.clear()
    return out
  }
}

const pending = new PendingMoves()

export function abandonPendingMoves(reason: string): MoveResult[] {
  return pending.drain(reason)
}

async function performMove(target: MoveTarget, log: (m: string) => void): Promise<MoveResult> {
  const label = target.name ?? target.id
  const csid = target.claudeSessionId
  if (!csid) return { session: label, ok: false, reason: 'no claudeSessionId — nothing to resume on forge' }
  const prep = await prepareRemoteSession({ sessionId: target.id, cwd: target.cwd, log })
  if (!prep.ok) return { session: label, ok: false, reason: prep.reason }
  const cfg = prep.cfg ?? forgeConfig()!

  if (!(await pushTranscript(cfg, target.cwd, csid, log))) {
    return { session: label, ok: false, reason: 'the transcript did not reach forge — refusing to move a session that could not resume there' }
  }

  const moved: string[] = []
  const repo = await repoForCwd(target.cwd)
  if (repo) {
    for (const wt of await worktreesForSession(repo, target.agentKey)) {
      const r = await ensureWorktreeOnForge(cfg, repo, wt, log)
      if (!r.ok) return { session: label, ok: false, reason: r.reason }
      moved.push(wt.path)
    }
  }

  const applied = target.applyPlacement('forge', prep.devPort ?? null)
  if (!applied.ok) return { session: label, ok: false, reason: applied.error ?? 'could not apply the placement' }

  const bits = [`on forge from its next message`]
  if (prep.devPort) bits.push(`dev port ${prep.devPort}`)
  bits.push(moved.length ? `${moved.length} worktree(s) synced with uncommitted changes` : 'no card worktree of its own')
  log(`[forge] moved ${label} → forge (${bits.join(', ')})`)
  return { session: label, ok: true, reason: bits.join(', '), devPort: prep.devPort ?? null, worktrees: moved }
}
