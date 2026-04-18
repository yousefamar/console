// Session manifest — persists active sessions across server restarts

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './session.js'

const MANIFEST_PATH = join(homedir(), '.claude', 'console-hub-sessions.json')

export interface ManifestEntry {
  claudeSessionId: string
  cwd: string
  prompt: string
  name?: string
  /** True if the session was actively running (mid-turn) when the manifest was last saved. */
  wasRunning?: boolean
}

/** Debounced manifest saver — coalesces rapid writes into one disk write */
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSessions: Map<string, Session> | null = null

export function saveManifest(sessions: Map<string, Session>) {
  pendingSessions = sessions
  if (!saveTimer) {
    saveTimer = setTimeout(flushManifest, 500)
  }
}

/** Force an immediate save (used on shutdown) */
export function saveManifestSync(sessions: Map<string, Session>) {
  pendingSessions = sessions
  flushManifest()
}

function flushManifest() {
  saveTimer = null
  if (!pendingSessions) return
  const sessions = pendingSessions
  pendingSessions = null

  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const session of sessions.values()) {
    if (session.status !== 'ended' && session.claudeSessionId && !seen.has(session.claudeSessionId)) {
      seen.add(session.claudeSessionId)
      entries.push({
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        prompt: session.initialPrompt,
        name: session.name,
        wasRunning: session.status === 'running',
      })
    }
  }
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2))
  } catch {
    // Best effort
  }
}

export function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const data = readFileSync(MANIFEST_PATH, 'utf-8')
    return JSON.parse(data) as ManifestEntry[]
  } catch {
    return []
  }
}
