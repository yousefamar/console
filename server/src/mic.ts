// Push-to-talk mic ownership.
//
// A single "mic owner" session receives the transcript of a push-to-talk
// capture (desktop super+c, or the phone's hardware button). Default owner
// is Al. Ownership is sticky until reassigned and persists across hub
// restarts. `hot` is transient (true only while a capture is live) and is
// broadcast so the SPA / waybar can flip the indicator red.
//
// This module only stores a session id string + the hot flag. Resolving the
// effective owner (the stored session if alive, else Al) and routing the
// transcript live in index.ts, where the session map + Al accessor are in
// scope.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const FILE = join(CONFIG_DIR, 'mic-owner.json')

export class MicState {
  private ownerSessionId: string | null = null
  private hot = false
  private listeners = new Set<() => void>()

  constructor() {
    try {
      if (existsSync(FILE)) {
        const o = JSON.parse(readFileSync(FILE, 'utf8')) as { ownerSessionId?: string | null }
        this.ownerSessionId = o.ownerSessionId ?? null
      }
    } catch { /* fresh / corrupt — default to null (effective owner falls back to Al) */ }
  }

  /** Fired whenever owner or hot changes. */
  onChange(fn: () => void): void { this.listeners.add(fn) }
  private emit(): void { for (const fn of this.listeners) { try { fn() } catch { /* noop */ } } }

  /** The explicitly-set owner session id (null = use the default, i.e. Al). */
  getOwnerSessionId(): string | null { return this.ownerSessionId }
  isHot(): boolean { return this.hot }

  setOwnerSessionId(sessionId: string | null): void {
    if (this.ownerSessionId === sessionId) return
    this.ownerSessionId = sessionId
    mkdirSync(CONFIG_DIR, { recursive: true })
    try { writeFileSync(FILE, JSON.stringify({ ownerSessionId: sessionId }, null, 2), 'utf8') } catch { /* best effort */ }
    this.emit()
  }

  setHot(hot: boolean): void {
    if (this.hot === hot) return
    this.hot = hot
    this.emit()
  }
}
