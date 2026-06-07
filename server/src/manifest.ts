// Session manifest — persists active sessions across server restarts

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './session.js'

const MANIFEST_PATH = join(homedir(), '.claude', 'console-hub-sessions.json')
const TMP_PATH = MANIFEST_PATH + '.tmp'

export interface ManifestEntry {
  claudeSessionId: string
  cwd: string
  prompt: string
  name?: string
  /** True if the session was actively running (mid-turn) when the manifest was last saved. */
  wasRunning?: boolean
}

/** Write the manifest synchronously and atomically.
 *
 *  Every call hits disk — there is no in-memory buffering or debounce.
 *  An SIGKILL'd hub still leaves a complete, up-to-date manifest behind.
 *  Atomic via write-to-tmp + rename so a crash mid-write can't corrupt the file.
 *
 *  We persist EVERY session with a claudeSessionId, including `ended` ones.
 *  Ended sessions get `--resume`'d on restart — Claude CLI handles that fine,
 *  and keeping them here means a subprocess dying (SDK timeout, host hibernate,
 *  etc.) doesn't silently delete the session from the user's sidebar. Removal
 *  is driven explicitly by `delete_session`, not by subprocess lifecycle.
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
      wasRunning: session.status === 'running',
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
