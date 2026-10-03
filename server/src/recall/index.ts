// Hub-side facade over the recall worker process: backfill scan, per-session
// re-index on turn end (debounced), hourly catch-up, and the search/read RPC.

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cwdToProjectDir } from '../utils.js'
import type { WorkerRequest, WorkerResponse, WorkerRole } from './worker.js'
import type { ReadParams, SearchParams } from './service.js'

export interface SessionNames { hubName?: string; agentKey?: string }

export interface RecallOptions {
  dbPath: string
  /** ~/.claude/projects */
  projectsDir: string
  /** hub-side names for a claudeSessionId, if it is (or was) a hub session */
  names: (claudeSessionId: string) => SessionNames
  log: (msg: string) => void
  /** ms of quiet after a turn end before that session is re-parsed */
  debounceMs?: number
  /** ms between full catch-up scans (terminal sessions the hub never sees end) */
  rescanMs?: number
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

export interface TranscriptFile { sessionId: string; path: string; mtimeMs: number }

export function listTranscripts(projectsDir: string): TranscriptFile[] {
  if (!existsSync(projectsDir)) return []
  const out: TranscriptFile[] = []
  for (const dir of readdirSync(projectsDir)) {
    const abs = join(projectsDir, dir)
    let entries: string[]
    try { entries = readdirSync(abs) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      try {
        const st = statSync(join(abs, f))
        if (st.isFile()) out.push({ sessionId: basename(f, '.jsonl'), path: join(abs, f), mtimeMs: st.mtimeMs })
      } catch { /* vanished mid-scan */ }
    }
  }
  // Newest first so a fresh index answers questions about recent work soonest.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** One forked worker process and its RPC bookkeeping. RecallIndex runs two:
 *  `index` (the writer) and `query` (read-only), so a search never queues behind
 *  a re-index — the writer's transaction can run for many minutes on a big
 *  transcript, and WAL lets the reader keep serving the last committed state. */
class WorkerSlot {
  private child: ChildProcess | null = null
  private spawnFailures = 0
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** set after 3 fast startup failures, or by stop() */
  disabled = false

  constructor(private role: WorkerRole, private dbPath: string, private log: (msg: string) => void) {}

  get running(): boolean { return !!this.child && this.child.connected }

  spawn(): void {
    if (this.disabled || this.child) return
    const here = dirname(fileURLToPath(import.meta.url))
    const ts = join(here, 'worker.ts')
    const file = existsSync(ts) ? ts : join(here, 'worker.js')
    // Keep the parent's loader flags (tsx under `npm run dev`) but drop
    // --env-file*, and silence node:sqlite's experimental notice.
    const execArgv = process.execArgv.filter((a) => !a.startsWith('--env-file'))
    execArgv.push('--disable-warning=ExperimentalWarning')
    const w = fork(file, [this.dbPath, this.role], { execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const spawnedAt = Date.now()
    w.on('message', (msg: WorkerResponse) => {
      this.spawnFailures = 0
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error !== undefined) p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    })
    w.on('error', (err) => this.log(`[recall] ${this.role} worker error: ${err.message}`))
    w.on('exit', (code) => {
      if (this.child !== w) return
      this.child = null
      for (const p of this.pending.values()) p.reject(new Error(`recall ${this.role} worker exited (${code})`))
      this.pending.clear()
      if (this.disabled) return
      // A worker that dies within seconds of starting is broken, not unlucky.
      if (Date.now() - spawnedAt < 10_000 && ++this.spawnFailures >= 3) {
        this.log(`[recall] ${this.role} worker failed ${this.spawnFailures}× at startup (exit ${code}) — disabled until the hub restarts`)
        this.disabled = true
        return
      }
      this.log(`[recall] ${this.role} worker exited with ${code}; respawning`)
      setTimeout(() => { if (!this.disabled) this.spawn() }, 1_000).unref?.()
    })
    this.child = w
  }

  call<T>(method: WorkerRequest['method'], params: Record<string, unknown>): Promise<T> {
    if (!this.child && !this.disabled) this.spawn()
    if (!this.child || !this.child.connected) return Promise.reject(new Error(`recall ${this.role} worker not running`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child!.send({ id, method, params } satisfies WorkerRequest)
    })
  }

  stop(): void {
    this.disabled = true
    this.child?.kill()
    this.child = null
    for (const p of this.pending.values()) p.reject(new Error('recall index stopped'))
    this.pending.clear()
  }
}

export class RecallIndex {
  private indexer: WorkerSlot
  /** spawned lazily on the first search/read/stats, so it opens a DB the
   *  indexer has already created (read-only connections cannot create one) */
  private querier: WorkerSlot
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private rescanTimer: ReturnType<typeof setInterval> | null = null
  private scanning: Promise<void> | null = null
  private stopped = false
  readonly debounceMs: number
  readonly rescanMs: number
  lastScan: { at: number; files: number; indexed: number; ms: number } | null = null

  constructor(private opts: RecallOptions) {
    this.debounceMs = opts.debounceMs ?? 8_000
    this.rescanMs = opts.rescanMs ?? 3_600_000
    this.indexer = new WorkerSlot('index', opts.dbPath, opts.log)
    this.querier = new WorkerSlot('query', opts.dbPath, opts.log)
  }

  start(): void {
    this.indexer.spawn()
    void this.scanAll()
    this.rescanTimer = setInterval(() => void this.scanAll(), this.rescanMs)
    this.rescanTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.rescanTimer) clearInterval(this.rescanTimer)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.indexer.stop()
    this.querier.stop()
  }

  private call<T>(method: WorkerRequest['method'], params: Record<string, unknown>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('recall index stopped'))
    const slot = method === 'index' || method === 'needsIndex' ? this.indexer : this.querier
    return slot.call<T>(method, params)
  }

  /** Index every transcript on disk whose size/mtime changed. One file per RPC
   *  so searches interleave with a long backfill. */
  scanAll(): Promise<void> {
    if (this.scanning) return this.scanning
    this.scanning = (async () => {
      const t0 = Date.now()
      const files = listTranscripts(this.opts.projectsDir)
      let indexed = 0
      let failures = 0
      for (const f of files) {
        if (this.stopped) return
        if (!this.indexer.running) { this.opts.log('[recall] scan aborted: index worker not running'); return }
        try {
          const r = await this.call<{ indexed: boolean }>('index', { sessionId: f.sessionId, path: f.path, meta: this.opts.names(f.sessionId) })
          if (r.indexed) indexed++
        } catch (err) {
          if (++failures <= 5) this.opts.log(`[recall] index ${f.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (failures > 5) this.opts.log(`[recall] scan: ${failures} transcripts failed to index (first 5 logged)`)
      this.lastScan = { at: Date.now(), files: files.length, indexed, ms: Date.now() - t0 }
      if (indexed) this.opts.log(`[recall] scan: ${indexed}/${files.length} transcripts (re)indexed in ${Date.now() - t0} ms`)
    })().finally(() => { this.scanning = null })
    return this.scanning
  }

  /** A hub session finished a turn (or ended): re-parse its transcript soon. */
  touch(claudeSessionId: string, cwd: string): void {
    if (this.stopped || !claudeSessionId) return
    const prev = this.timers.get(claudeSessionId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      this.timers.delete(claudeSessionId)
      void this.indexSession(claudeSessionId, cwd)
    }, this.debounceMs)
    timer.unref?.()
    this.timers.set(claudeSessionId, timer)
  }

  async indexSession(claudeSessionId: string, cwd: string): Promise<boolean> {
    const path = join(this.opts.projectsDir, cwdToProjectDir(cwd), `${claudeSessionId}.jsonl`)
    if (!existsSync(path)) return false
    try {
      const r = await this.call<{ indexed: boolean }>('index', { sessionId: claudeSessionId, path, meta: this.opts.names(claudeSessionId) })
      return r.indexed
    } catch (err) {
      this.opts.log(`[recall] index ${claudeSessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  search(p: SearchParams): Promise<{ text: string; hits: number; fallback?: string }> {
    return this.call('search', p as unknown as Record<string, unknown>)
  }

  read(p: ReadParams): Promise<{ text: string }> {
    return this.call('read', p as unknown as Record<string, unknown>)
  }

  async stats(): Promise<{ sessions: number; turns: number; toolEvents: number; dbBytes: number; lastScan: RecallIndex['lastScan']; scanning: boolean }> {
    const s = await this.call<{ sessions: number; turns: number; toolEvents: number }>('stats', {})
    let dbBytes = 0
    try { dbBytes = statSync(this.opts.dbPath).size } catch { /* not yet created */ }
    return { ...s, dbBytes, lastScan: this.lastScan, scanning: this.scanning !== null }
  }
}
