// ListWatcher — enrichment is a property of the FILE, not of whoever wrote
// the row. Polls the vault (NoteStore.listSince, the BoardWatcher primitive)
// for changes to list notes that declare an enricher, gathers the rows whose
// enrichment is pending, hands them to the enricher in one batch, and applies
// the results: fill cells, or remove the row (queue semantics) and log it. A
// row Yousef types by hand in Notes is handled exactly like a spoken one.
//
// Debounce: a file touched < QUIET_MS ago is left alone (half-typed row) and
// re-examined next tick. A row whose enrichment FAILED backs off; a row that
// is merely "not yet" (no open order) is re-tried on every sweep. A periodic
// sweep re-examines every list so queue drains happen when an order opens
// even if no file changed.

import type { NoteStore } from '../notes.js'
import { ENRICHERS, type EnricherDeps, type RowResult } from './enrichers.js'
import { parseTable, rowRecord, setCells, removeRow } from './table.js'
import { appendLogEntry } from '../ring/append.js'

export interface ListTargetSpec { file: string; enrich?: string; dated?: boolean }

export interface ListWatcherOpts {
  /** Configured list targets, by name (the ring schema note today). */
  targets: () => Promise<Record<string, ListTargetSpec>>
  deps: Omit<EnricherDeps, 'log'>
  log: (msg: string) => void
  pollMs?: number
  quietMs?: number
  retryMs?: number
  sweepMs?: number
  now?: () => number
}

const DEFAULT_POLL_MS = 10_000
const DEFAULT_QUIET_MS = 5_000
const DEFAULT_RETRY_MS = 60 * 60_000
const DEFAULT_SWEEP_MS = 30 * 60_000

export class ListWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPoll = 0
  private lastSweep = 0
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
    this.lastSweep = this.now()
    for (const file of (await this.watchedFiles()).keys()) this.pending.add(file)
    await this.poll()
    this.timer = setInterval(() => { void this.poll() }, this.opts.pollMs ?? DEFAULT_POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** `con notes enrich` — examine every configured list now, ignoring backoff. */
  async runNow(): Promise<number> {
    let n = 0
    for (const file of (await this.watchedFiles()).keys()) n += await this.enrichFile(file, { force: true })
    return n
  }

  private async watchedFiles(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const [name, t] of Object.entries(await this.opts.targets())) if (t.enrich && !t.dated && ENRICHERS[t.enrich]) out.set(t.file, name)
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
      if (this.now() - this.lastSweep >= (this.opts.sweepMs ?? DEFAULT_SWEEP_MS)) {
        this.lastSweep = this.now()
        for (const file of watched.keys()) this.pending.add(file)
      }
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
      this.opts.log(`[lists] poll: ${(e as Error).message}`)
    } finally {
      this.scanning = false
    }
  }

  /** Run the enricher over every pending row of one file. Returns rows changed. */
  private async enrichFile(file: string, { force }: { force: boolean }): Promise<number> {
    const targets = await this.opts.targets()
    const entry = Object.entries(targets).find(([, t]) => t.file === file)
    if (!entry) return 0
    const [target, spec] = entry
    const enricher = spec.enrich ? ENRICHERS[spec.enrich] : undefined
    if (!enricher) return 0

    let content: string
    try { content = await this.store.read(file) } catch { return 0 }
    const table = parseTable(content.split('\n'))
    if (!table) return 0
    const keyOf = (cells: string[]) => `${file}\n${cells.join('|')}`
    const candidates = table.rows.filter((r) => {
      const rec = rowRecord(table, r)
      if (!enricher.pending(rec)) return false
      return force || (this.backoff.get(keyOf(r.cells)) ?? 0) <= this.now()
    })
    if (!candidates.length) return 0

    const deps: EnricherDeps = { ...this.opts.deps, log: this.opts.log }
    let results: RowResult[]
    try {
      results = await enricher.run(candidates.map((r) => rowRecord(table, r)), deps)
    } catch (e) {
      this.opts.log(`[lists] ${spec.enrich} threw on ${target}: ${(e as Error).message}`)
      const until = this.now() + (this.opts.retryMs ?? DEFAULT_RETRY_MS)
      for (const r of candidates) this.backoff.set(keyOf(r.cells), until)
      return 0
    }

    // Apply against a FRESH read — the enricher may have taken minutes and the
    // file may have moved; rows are located by content, never by old index.
    let latest: string
    try { latest = await this.store.read(file) } catch { return 0 }
    let changed = 0
    const logLines: Array<{ file: string; text: string }> = []
    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i]!
      const res = results[i]
      if (!res) continue
      const key = keyOf(row.cells)
      const item = rowRecord(table, row)[enricher.itemColumn?.toLowerCase() ?? 'item'] ?? row.cells.join(' ')
      if (res.kind === 'skip') {
        if (res.retry) this.backoff.set(key, this.now() + (this.opts.retryMs ?? DEFAULT_RETRY_MS))
        this.opts.log(`[lists] ${target}: "${item}" left pending${res.reason ? ` — ${res.reason}` : ''}`)
        continue
      }
      const cur = parseTable(latest.split('\n'))
      const still = cur?.rows.find((r) => r.cells.join('|') === row.cells.join('|'))
      if (!cur || !still) continue
      if (res.kind === 'fill') {
        latest = setCells(latest, still.line, res.cells)
        this.opts.log(`[lists] ${target}: "${item}" → ${Object.entries(res.cells).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      } else {
        latest = removeRow(latest, still.line)
        if (res.logTo && res.note) logLines.push({ file: res.logTo, text: res.note })
        this.opts.log(`[lists] ${target}: "${item}" drained${res.note ? ` — ${res.note}` : ''}`)
      }
      this.backoff.delete(key)
      changed++
    }
    if (changed) await this.store.write(file, latest)
    for (const l of logLines) {
      let existing: string | null = null
      try { existing = await this.store.read(l.file) } catch { existing = null }
      await this.store.write(l.file, appendLogEntry(existing, l.text, new Date(this.now())))
    }
    return changed
  }
}
