// Session manifest — persists active sessions across server restarts

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './session.js'
import type { AttentionState } from './protocol.js'

const MANIFEST_PATH = join(homedir(), '.claude', 'console-hub-sessions.json')
const TMP_PATH = MANIFEST_PATH + '.tmp'

export interface ManifestEntry {
  claudeSessionId: string
  cwd: string
  prompt: string
  name?: string
  /** claudeSessionId of the parent session (forks) — restores sidebar nesting. */
  parentClaudeSessionId?: string
  /** Durable org-chart role key (agents/registry.ts) this session embodies. */
  agentKey?: string
  /** True if the session was actively running (mid-turn) when the manifest was last saved. */
  wasRunning?: boolean
  /** True if the USER explicitly ended this session (kill/delete). Restore
   *  skips + prunes these — an explicit "End session" must survive restarts.
   *  Absent for incidental subprocess deaths, which DO get resumed. */
  ended?: boolean
  /** Sticky `@amar` attention marker — survives hub restart. */
  needsAttention?: AttentionState | null
}

/** Write the manifest synchronously and atomically.
 *
 *  Every call hits disk — there is no in-memory buffering or debounce.
 *  An SIGKILL'd hub still leaves a complete, up-to-date manifest behind.
 *  Atomic via write-to-tmp + rename so a crash mid-write can't corrupt the file.
 *
 *  We persist EVERY session with a claudeSessionId, including `ended` ones,
 *  so a subprocess dying (SDK timeout, host hibernate, etc.) doesn't silently
 *  delete the session from the user's sidebar — those get `--resume`'d on
 *  restart. Sessions the USER explicitly ended carry `ended: true` and are
 *  skipped + pruned by the restore loop instead of resurrected. Removal is
 *  driven by `delete_session` (or `ended` pruning), never by subprocess
 *  lifecycle alone.
 */
export function saveManifest(sessions: Map<string, Session>) {
  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const session of sessions.values()) {
    if (!session.claudeSessionId || seen.has(session.claudeSessionId)) continue
    seen.add(session.claudeSessionId)
    entries.push({
      claudeSessionId: session.claudeSessionId,
      cwd: session.cwd,
      prompt: session.initialPrompt,
      name: session.name,
      ...(session.parentClaudeSessionId ? { parentClaudeSessionId: session.parentClaudeSessionId } : {}),
      ...(session.agentKey ? { agentKey: session.agentKey } : {}),
      wasRunning: session.status === 'running',
      ...(session.endedByUser ? { ended: true } : {}),
      ...(session.needsAttention ? { needsAttention: session.needsAttention } : {}),
    })
  }
  try {
    writeFileSync(TMP_PATH, JSON.stringify(entries, null, 2))
    renameSync(TMP_PATH, MANIFEST_PATH)
  } catch {
    // Best effort
  }
}

/** Kept for callsite compatibility — manifest is always written synchronously now. */
export const saveManifestSync = saveManifest

export function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const data = readFileSync(MANIFEST_PATH, 'utf-8')
    return JSON.parse(data) as ManifestEntry[]
  } catch {
    return []
  }
}
