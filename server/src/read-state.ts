// ============================================================================
// Per-session read state — persisted to disk so unread/read survives hub
// restarts and syncs across clients (mobile + desktop). Keyed by
// claudeSessionId for Claude sessions; the special string 'al' for Al.
//
// The state is `lastReadIndex`: how many messages were in the session log
// when the user last marked it read. `hasUnread` is derived as
// `messageLog.length > lastReadIndex`. Storing the index (not a timestamp)
// avoids clock drift and is robust to bursts of fast messages.
//
// A session can also be PINNED read: approving a hand-back card marks the
// fork read and pins it, so the wind-down turn that follows (summary, merge
// digest) never re-flags it — it stays read until it is folded into its
// parent (or deleted, marked unread, or its card is reopened). While pinned,
// every logged message advances lastReadIndex to the log length.
// ============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const FILE = join(CONFIG_DIR, 'agent-read-state.json')

interface ReadStateFile {
  /** session key → lastReadIndex */
  read: Record<string, number>
  /** session key → epoch ms when it was pinned read */
  pinned: Record<string, number>
}

let cache: ReadStateFile | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let logFn: (msg: string) => void = () => {}

export function setReadStateLogger(fn: (msg: string) => void) { logFn = fn }

/** The v1 file was a flat `{ [key]: lastReadIndex }`; v2 nests it under `read`. */
export function parseReadStateFile(raw: unknown): ReadStateFile {
  const empty: ReadStateFile = { read: {}, pinned: {} }
  if (!raw || typeof raw !== 'object') return empty
  const o = raw as Record<string, unknown>
  if (o.read && typeof o.read === 'object') {
    return {
      read: { ...(o.read as Record<string, number>) },
      pinned: o.pinned && typeof o.pinned === 'object' ? { ...(o.pinned as Record<string, number>) } : {},
    }
  }
  const read: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number') read[k] = v
  return { read, pinned: {} }
}

function load(): ReadStateFile {
  if (cache) return cache
  if (!existsSync(FILE)) { cache = { read: {}, pinned: {} }; return cache }
  try {
    cache = parseReadStateFile(JSON.parse(readFileSync(FILE, 'utf-8')))
  } catch (e) {
    logFn(`[read-state] load failed: ${(e as Error).message}`)
    cache = { read: {}, pinned: {} }
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
  return load().read[key] ?? 0
}

export function setLastReadIndex(key: string, idx: number) {
  const c = load()
  c.read[key] = Math.max(0, Math.floor(idx))
  scheduleSave()
}

/** Keep this session read whatever it logs next, until `unpinRead`. */
export function pinRead(key: string) {
  const c = load()
  c.pinned[key] = Date.now()
  scheduleSave()
}

/** Returns true if the session was pinned. */
export function unpinRead(key?: string): boolean {
  if (!key) return false
  const c = load()
  if (!(key in c.pinned)) return false
  delete c.pinned[key]
  scheduleSave()
  return true
}

export function isReadPinned(key?: string): boolean {
  if (!key) return false
  return key in load().pinned
}

/** Tests only: replace the in-memory state without touching disk. */
export function _resetReadStateForTests(state: ReadStateFile = { read: {}, pinned: {} }) {
  cache = state
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
}
