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
