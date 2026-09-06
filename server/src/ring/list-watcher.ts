// ListWatcher — enrichment is a property of the FILE, not of the ring. Polls
// the vault (NoteStore.listSince, the BoardWatcher primitive) for changes to
// list notes that declare an `enrich:` in the schema, finds rows whose
// enrichment columns are still empty, fills them, writes back. A row Yousef
// types by hand in Notes gets enriched exactly like a ring-spoken one.
//
// Debounce: a file touched < QUIET_MS ago is left alone (half-typed row) and
// re-examined next tick. Failures back off per row so a stubborn title can't
// burn the LLM every 10 s.

import type { NoteStore } from '../notes.js'
import type { RingSchema } from './schema.js'
import { ENRICHERS, type EnricherDeps } from './enrichers.js'
import { parseTable, rowRecord, setCells } from './table.js'

export interface ListWatcherOpts {
  schema: () => Promise<{ schema: RingSchema }>
  deps: EnricherDeps
  log: (msg: string) => void
  onEnriched?: (file: string, target: string, before: Record<string, string>, after: Record<string, string>) => void
  pollMs?: number
  quietMs?: number
  retryMs?: number
  now?: () => number
}

const DEFAULT_POLL_MS = 10_000
const DEFAULT_QUIET_MS = 5_000
const DEFAULT_RETRY_MS = 60 * 60_000

export class ListWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPoll = 0
  private scanning = false
  /** Files to look at again even though listSince won't report them. */
  private pending = new Set<string>()
  /** `${file}\n${rowKey}` → next attempt time, after a failed enrichment. */
  private backoff = new Map<string, number>()

  constructor(private store: NoteStore, private opts: ListWatcherOpts) {}

  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  /** Boot: every configured list is examined once (edits made while the hub was down). */
  async start(): Promise<void> {
    this.lastPoll = this.now()
    for (const file of (await this.watchedFiles()).keys()) this.pending.add(file)
    await this.poll()
    this.timer = setInterval(() => { void this.poll() }, this.opts.pollMs ?? DEFAULT_POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** `con ring enrich` — examine every configured list now, no debounce. */
  async runNow(): Promise<number> {
    let n = 0
    for (const file of (await this.watchedFiles()).keys()) n += await this.enrichFile(file, { force: true })
    return n
  }

  private async watchedFiles(): Promise<Map<string, string>> {
    const { schema } = await this.opts.schema()
    const out = new Map<string, string>()
    for (const [name, t] of Object.entries(schema.verbs.add.targets)) if (t.enrich && !t.dated) out.set(t.file, name)
    return out
  }

  async poll(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const since = this.lastPoll
      this.lastPoll = this.now()
      const watched = await this.watchedFiles()
      const { files } = await this.store.listSince(since)
      const quiet = this.opts.quietMs ?? DEFAULT_QUIET_MS
      const mtimes = new Map(files.map((f) => [f.path, f.mtime] as const))
      for (const f of files) if (watched.has(f.path)) this.pending.add(f.path)
      const todo = [...this.pending].filter((f) => watched.has(f))
      this.pending.clear()
      // Carried-over files have no mtime from this tick — one vault listing covers them all.
      if (todo.some((f) => !mtimes.has(f))) {
        for (const f of await this.store.list()) if (todo.includes(f.path)) mtimes.set(f.path, f.mtime)
      }
      for (const file of todo) {
        const mtime = mtimes.get(file)
        if (mtime !== undefined && this.now() - mtime < quiet) { this.pending.add(file); continue }
        await this.enrichFile(file, { force: false })
      }
    } catch (e) {
      this.opts.log(`[ring/lists] poll: ${(e as Error).message}`)
    } finally {
      this.scanning = false
    }
  }

  /** Enrich every pending row in one file. Returns rows changed. */
  private async enrichFile(file: string, { force }: { force: boolean }): Promise<number> {
    const watched = await this.watchedFiles()
    const target = watched.get(file)
    if (!target) return 0
    const { schema } = await this.opts.schema()
    const enrichName = schema.verbs.add.targets[target]?.enrich
    const enricher = enrichName ? ENRICHERS[enrichName] : undefined
    if (!enricher) return 0

    let changed = 0
    const attempted = new Set<string>()
    // Re-read before EVERY row: the LLM call takes seconds and the file may
    // have moved under us; locate the row by its content, not its old index.
    for (let guard = 0; guard < 50; guard++) {
      let content: string
      try { content = await this.store.read(file) } catch { return changed }
      const lines = content.split('\n')
      const table = parseTable(lines)
      if (!table) return changed
      const row = table.rows.find((r) => {
        const rec = rowRecord(table, r)
        if (!enricher.pending(rec)) return false
        const key = `${file}\n${r.cells.join('|')}`
        if (attempted.has(key)) return false
        return force || (this.backoff.get(key) ?? 0) <= this.now()
      })
      if (!row) return changed
      const rec = rowRecord(table, row)
      const key = `${file}\n${row.cells.join('|')}`
      attempted.add(key)
      let fill: Record<string, string> | null = null
      try { fill = await enricher.run(rec, this.opts.deps) } catch (e) { this.opts.log(`[ring/lists] ${enrichName} failed on "${rec[enricher.itemColumn?.toLowerCase() ?? 'item']}": ${(e as Error).message}`) }
      if (!fill) {
        this.backoff.set(key, this.now() + (this.opts.retryMs ?? DEFAULT_RETRY_MS))
        this.opts.log(`[ring/lists] ${target}: could not enrich "${rec[enricher.itemColumn?.toLowerCase() ?? 'item']}" — will retry later`)
        continue
      }
      // Re-read once more and apply only if the row is still there unchanged.
      let latest: string
      try { latest = await this.store.read(file) } catch { return changed }
      const latestLines = latest.split('\n')
      const latestTable = parseTable(latestLines)
      const still = latestTable?.rows.find((r) => r.cells.join('|') === row.cells.join('|'))
      if (!latestTable || !still) continue
      await this.store.write(file, setCells(latest, still.line, fill))
      changed++
      this.backoff.delete(key)
      const after = { ...rec, ...Object.fromEntries(Object.entries(fill).map(([k, v]) => [k.toLowerCase(), v])) }
      this.opts.log(`[ring/lists] ${target}: "${rec[enricher.itemColumn?.toLowerCase() ?? 'item']}" → ${Object.entries(fill).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      this.opts.onEnriched?.(file, target, rec, after)
    }
    return changed
  }
}
