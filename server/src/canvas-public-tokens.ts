// Public-token registry for canvas tabs + islands.
//
// Stored at ~/.config/console/canvas-public-tokens.json — a SIBLING of the
// canvas dir, deliberately outside it. CanvasDir.clear() wipes everything
// inside canvas/ but leaves this file alone, so a `con dashboard canvas
// reset` does NOT silently revoke every share URL. Explicit unpublish does.
//
// Token format: 32 random bytes, base64url. Never logged.

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const TOKENS_FILE = join(CONFIG_DIR, 'canvas-public-tokens.json')

export type PublicKind = 'island' | 'tab'

export interface PublicTokenEntry {
  kind: PublicKind
  slug: string
  token: string
  createdAt: number
}

interface FileShape {
  version: 1
  entries: PublicTokenEntry[]
}

export class CanvasPublicTokens {
  private entries: PublicTokenEntry[] = []
  /** kind:slug → entry (one publish per (kind, slug)) */
  private bySlug = new Map<string, PublicTokenEntry>()
  /** token → entry (resolved on every public lookup, constant-time compared) */
  private byToken = new Map<string, PublicTokenEntry>()

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(TOKENS_FILE)) {
        const raw = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as Partial<FileShape>
        if (raw?.version === 1 && Array.isArray(raw.entries)) {
          this.entries = raw.entries.filter((e) =>
            e && typeof e.kind === 'string' && typeof e.slug === 'string' &&
            typeof e.token === 'string' && typeof e.createdAt === 'number',
          )
        }
      }
    } catch {
      this.entries = []
    }
    this.rebuildIndex()
  }

  private save(): void {
    mkdirSync(CONFIG_DIR, { recursive: true })
    const payload: FileShape = { version: 1, entries: this.entries }
    writeFileSync(TOKENS_FILE, JSON.stringify(payload, null, 2), 'utf8')
    try { chmodSync(TOKENS_FILE, 0o600) } catch { /* non-unix */ }
  }

  private rebuildIndex(): void {
    this.bySlug.clear()
    this.byToken.clear()
    for (const e of this.entries) {
      this.bySlug.set(`${e.kind}:${e.slug}`, e)
      this.byToken.set(e.token, e)
    }
  }

  /**
   * Publish a tab/island. Idempotent: returns the existing token if one is
   * already issued, otherwise mints a new one. The token is the entire share
   * surface — losing it via the canvas UI/CLI means re-issuing.
   */
  publish(kind: PublicKind, slug: string): PublicTokenEntry {
    const key = `${kind}:${slug}`
    const existing = this.bySlug.get(key)
    if (existing) return existing
    const entry: PublicTokenEntry = {
      kind,
      slug,
      token: randomBytes(32).toString('base64url'),
      createdAt: Date.now(),
    }
    this.entries.push(entry)
    this.rebuildIndex()
    this.save()
    return entry
  }

  /** Revoke. Returns whether anything was removed. */
  unpublish(kind: PublicKind, slug: string): boolean {
    const key = `${kind}:${slug}`
    const existing = this.bySlug.get(key)
    if (!existing) return false
    this.entries = this.entries.filter((e) => !(e.kind === kind && e.slug === slug))
    this.rebuildIndex()
    this.save()
    return true
  }

  /** Resolve a presented token, timing-safe. Returns null on miss. */
  resolve(presented: string): PublicTokenEntry | null {
    if (!presented) return null
    // Map lookup first to short-circuit obvious misses, then a final
    // timing-safe compare against the matched entry's token. The Map probe
    // itself is not timing-safe but the value space (random 32-byte b64url)
    // is far too sparse for the timing of negative hits to leak meaningful
    // information.
    const hit = this.byToken.get(presented)
    if (!hit) return null
    const a = Buffer.from(hit.token)
    const b = Buffer.from(presented)
    if (a.length !== b.length) return null
    return timingSafeEqual(a, b) ? hit : null
  }

  /** UI-facing listing — does NOT expose the token plaintexts. */
  list(): Array<Omit<PublicTokenEntry, 'token'> & { tokenPrefix: string }> {
    return this.entries.map(({ token, ...rest }) => ({ ...rest, tokenPrefix: token.slice(0, 8) }))
  }

  /** Internal: get an entry by (kind, slug). Used by the CLI `url` verb. */
  getBySlug(kind: PublicKind, slug: string): PublicTokenEntry | null {
    return this.bySlug.get(`${kind}:${slug}`) ?? null
  }
}

export const PUBLIC_TOKENS_PATH = TOKENS_FILE
