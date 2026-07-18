// ============================================================================
// DedupStore — persisted client-token → result map for non-idempotent
// upstream APIs (Gmail send, Calendar create). An offline outbox retries a
// queued mutation with the same token; the first success records the result,
// replays return it without re-executing. Pruned by age on load + write.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

interface Entry {
  result: unknown
  ts: number
}

export class DedupStore {
  private map: Record<string, Entry> = {}

  constructor(
    private readonly path: string,
    private readonly maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  ) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      this.map = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, Entry>
      this.prune()
    } catch {
      this.map = {}
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAgeMs
    for (const [k, v] of Object.entries(this.map)) {
      if (v.ts < cutoff) delete this.map[k]
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.map))
    renameSync(tmp, this.path)
  }

  /** Previously-recorded result for a token, or undefined. */
  get(token: string): unknown | undefined {
    return this.map[token]?.result
  }

  /** Record a successful execution's result for future replays. */
  record(token: string, result: unknown): void {
    this.prune()
    this.map[token] = { result, ts: Date.now() }
    this.persist()
  }

  /**
   * Execute-once helper: returns the recorded result when the token is known,
   * otherwise runs `fn` and records. Tokens must be client-minted UUIDs —
   * an empty/missing token always executes.
   */
  async once<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (token) {
      const prior = this.get(token)
      if (prior !== undefined) return prior as T
    }
    const result = await fn()
    if (token) this.record(token, result)
    return result
  }
}
