// Session manifest — persists active sessions across server restarts

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './session.js'

const MANIFEST_PATH = join(homedir(), '.claude', 'console-hub-sessions.json')

export interface ManifestEntry {
  claudeSessionId: string
  cwd: string
  prompt: string
}

export function saveManifest(sessions: Map<string, Session>) {
  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const session of sessions.values()) {
    if (session.status !== 'ended' && session.claudeSessionId && !seen.has(session.claudeSessionId)) {
      seen.add(session.claudeSessionId)
      entries.push({
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        prompt: session.initialPrompt,
      })
    }
  }
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2))
  } catch {
    // Best effort
  }
}

export function loadAndClearManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const data = readFileSync(MANIFEST_PATH, 'utf-8')
    unlinkSync(MANIFEST_PATH)
    return JSON.parse(data) as ManifestEntry[]
  } catch {
    return []
  }
}
