// ============================================================================
// Per-session read state — persisted to disk so unread/read survives hub
// restarts and syncs across clients (mobile + desktop). Keyed by
// claudeSessionId for Claude sessions; the special string 'al' for Al.
//
// The state is `lastReadIndex`: how many messages were in the session log
// when the user last marked it read. `hasUnread` is derived as
// `messageLog.length > lastReadIndex`. Storing the index (not a timestamp)
// avoids clock drift and is robust to bursts of fast messages.
// ============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const FILE = join(CONFIG_DIR, 'agent-read-state.json')

let cache: Record<string, number> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let logFn: (msg: string) => void = () => {}

export function setReadStateLogger(fn: (msg: string) => void) { logFn = fn }

function load(): Record<string, number> {
  if (cache) return cache
  if (!existsSync(FILE)) { cache = {}; return cache }
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf-8')) as Record<string, number>
  } catch (e) {
    logFn(`[read-state] load failed: ${(e as Error).message}`)
    cache = {}
  }
  return cache
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushReadState()
  }, 500)
}

/** Force-flush pending writes (e.g. on shutdown). */
export function flushReadState() {
  if (!cache) return
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(cache))
  } catch (e) {
    logFn(`[read-state] save failed: ${(e as Error).message}`)
  }
}

export function getLastReadIndex(key?: string): number {
  if (!key) return 0
  return load()[key] ?? 0
}

export function setLastReadIndex(key: string, idx: number) {
  const c = load()
  c[key] = Math.max(0, Math.floor(idx))
  scheduleSave()
}
