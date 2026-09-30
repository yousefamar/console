// The one machine-initiated wake path (cron fires, event listeners). An idle
// session gets the prompt now; a session mid-turn gets it QUEUED — a stdin
// write during a turn lands as a second user message at the next tool
// boundary (the stream-json behaviour ~/CLAUDE.md records as broken), and the
// session's own queue already delivers at `result`. An identical prompt
// already pending is not stacked.

import type { Session } from '../session.js'
import type { HubMessage } from '../protocol.js'

export type WakeOutcome = 'fired' | 'queued' | 'queued-dup'

export function findByClaudeSessionId(sessions: Iterable<Session>, claudeSessionId: string): Session | undefined {
  for (const s of sessions) if (s.claudeSessionId === claudeSessionId) return s
  return undefined
}

export function wakeOrQueue(session: Session, content: string, broadcast: (msg: HubMessage) => void): WakeOutcome {
  if (session.status === 'running') {
    if (session.queuedMessage?.includes(content)) return 'queued-dup'
    session.queueMessage(content)
    return 'queued'
  }
  const userMsg: HubMessage = { type: 'user_prompt', sessionId: session.id, content }
  broadcast(userMsg)
  session.logMessage(userMsg)
  session.sendMessage(content)
  return 'fired'
}

export function describeWake(o: WakeOutcome): string {
  return o === 'fired' ? 'fired' : o === 'queued' ? 'queued (session mid-turn)' : 'queued (already pending from an earlier fire)'
}

const FORK_SETTLE_MS = 2_000
const FORK_IDLE_CAP_MS = 30 * 60_000

/** Close a single-turn wake fork (listener `--fork`, cron `--fork`) 2 s after
 *  its first `result`. A fork that raised the attention marker asked for
 *  Yousef and stays; one silent for 30 min (a permission prompt nobody
 *  answers) is left alive and logged, never killed mid-work. */
export function reapForkAfterTurn(fork: Session, opts: { label: string; closeFork: (fork: Session) => void; log: (m: string) => void }): void {
  let cap: ReturnType<typeof setTimeout> | undefined
  const armCap = () => {
    if (cap) clearTimeout(cap)
    cap = setTimeout(() => {
      fork.off('hub_message', onMsg)
      opts.log(`${opts.label}: no result after ${FORK_IDLE_CAP_MS / 60_000} min idle — left alive, close it by hand`)
    }, FORK_IDLE_CAP_MS)
    cap.unref?.()
  }
  const onMsg = (m: HubMessage) => {
    armCap()
    if (m.type !== 'result') return
    fork.off('hub_message', onMsg)
    if (cap) clearTimeout(cap)
    setTimeout(() => {
      if (fork.status === 'ended') return
      if (fork.needsAttention) { opts.log(`${opts.label}: asked for Yousef — left alive`); return }
      opts.closeFork(fork)
      opts.log(`${opts.label}: turn done ($${m.cost.toFixed(3)}) — closed`)
    }, FORK_SETTLE_MS).unref?.()
  }
  armCap()
  fork.on('hub_message', onMsg)
}
