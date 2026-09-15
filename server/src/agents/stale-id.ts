// Hub session ids are minted per hub process, so any id a caller saved before a
// restart points at nothing afterwards — while the conversation itself lives
// on under a new id (same claudeSessionId). These helpers turn that void into
// a pointer at the successor.

import type { Session } from '../session.js'

/** The live session that carried `id` in an earlier hub process, if any. */
export function findByFormerId(sessions: Map<string, Session>, id: string): Session | undefined {
  for (const s of sessions.values()) {
    if (s.formerIds.includes(id)) return s
  }
  return undefined
}

/** Error text for a hub session id that matches nothing live. Names the
 *  successor when the id is merely pre-restart, and the restart-proof
 *  addresses (agentKey / claudeSessionId) either way. */
export function missingSessionMessage(sessions: Map<string, Session>, id: string): string {
  const successor = findByFormerId(sessions, id)
  if (!successor) return `Session not found: ${id}`
  const label = successor.name ? ` (${successor.name})` : ''
  const stable = successor.agentKey ?? successor.claudeSessionId
  return `Session not found: ${id} — the hub restarted since; that conversation is now ${successor.id}${label}.`
    + (stable ? ` Address it as "${stable}" to survive restarts.` : '')
}
