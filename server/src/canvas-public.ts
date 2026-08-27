// Public-publish registry for canvas tabs + islands. NO tokens — publish
// means the plain slug URL is public: /public/canvas/<tab|island>/<slug>/.
// Unpublish removes it (404).
//
// Stored at ~/.config/console/canvas-public.json — a SIBLING of the canvas
// dir, deliberately outside it. CanvasDir.clear() wipes everything inside
// canvas/ but leaves this file alone, so a `con dashboard canvas reset` does
// NOT silently unpublish. Explicit unpublish does.
//
// One-time migration: the retired token scheme's canvas-public-tokens.json is
// imported (entries keep their kind/slug, tokens dropped) if the new file
// doesn't exist yet.

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const REGISTRY_FILE = join(CONFIG_DIR, 'canvas-public.json')
const LEGACY_TOKENS_FILE = join(CONFIG_DIR, 'canvas-public-tokens.json')

export type PublicKind = 'island' | 'tab'

export interface PublicEntry {
  kind: PublicKind
  slug: string
  createdAt: number
}

interface FileShape {
  version: 2
  entries: PublicEntry[]
}

export class CanvasPublicRegistry {
  private entries: PublicEntry[] = []
  private bySlug = new Map<string, PublicEntry>()

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(REGISTRY_FILE)) {
        const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Partial<FileShape>
        if (raw?.version === 2 && Array.isArray(raw.entries)) {
          this.entries = raw.entries.filter((e) =>
            e && (e.kind === 'tab' || e.kind === 'island') && typeof e.slug === 'string' &&
            typeof e.createdAt === 'number',
          )
        }
      } else if (existsSync(LEGACY_TOKENS_FILE)) {
        // Migrate published state from the token era (tokens themselves die).
        const raw = JSON.parse(readFileSync(LEGACY_TOKENS_FILE, 'utf8')) as {
          entries?: Array<{ kind?: string; slug?: string; createdAt?: number }>
        }
        if (Array.isArray(raw?.entries)) {
          this.entries = raw.entries
            .filter((e) => (e?.kind === 'tab' || e?.kind === 'island') && typeof e.slug === 'string')
            .map((e) => ({ kind: e.kind as PublicKind, slug: e.slug!, createdAt: e.createdAt ?? Date.now() }))
          this.save()
        }
      }
    } catch {
      this.entries = []
    }
    this.rebuildIndex()
  }

  private save(): void {
    mkdirSync(CONFIG_DIR, { recursive: true })
    const payload: FileShape = { version: 2, entries: this.entries }
    writeFileSync(REGISTRY_FILE, JSON.stringify(payload, null, 2), 'utf8')
    try { chmodSync(REGISTRY_FILE, 0o600) } catch { /* non-unix */ }
  }

  private rebuildIndex(): void {
    this.bySlug.clear()
    for (const e of this.entries) this.bySlug.set(`${e.kind}:${e.slug}`, e)
  }

  /** Publish a tab/island. Idempotent. */
  publish(kind: PublicKind, slug: string): PublicEntry {
    const existing = this.bySlug.get(`${kind}:${slug}`)
    if (existing) return existing
    const entry: PublicEntry = { kind, slug, createdAt: Date.now() }
    this.entries.push(entry)
    this.rebuildIndex()
    this.save()
    return entry
  }

  /** Unpublish. Returns whether anything was removed. */
  unpublish(kind: PublicKind, slug: string): boolean {
    if (!this.bySlug.has(`${kind}:${slug}`)) return false
    this.entries = this.entries.filter((e) => !(e.kind === kind && e.slug === slug))
    this.rebuildIndex()
    this.save()
    return true
  }

  isPublished(kind: PublicKind, slug: string): boolean {
    return this.bySlug.has(`${kind}:${slug}`)
  }

  getBySlug(kind: PublicKind, slug: string): PublicEntry | null {
    return this.bySlug.get(`${kind}:${slug}`) ?? null
  }

  list(): PublicEntry[] {
    return [...this.entries]
  }
}

export const PUBLIC_REGISTRY_PATH = REGISTRY_FILE
