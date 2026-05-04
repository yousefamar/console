// ============================================================================
// Hub-side scheduler for agent sessions.
//
// Why this exists: Claude Code's built-in /loop & CronCreate are session-scoped
// and DO NOT survive hub restarts under our SDK transport (--input-format
// stream-json). Empirically verified; see the plan at
// ~/.claude/plans/imperative-cooking-grove.md and Anthropic bugs #40228, #40081.
//
// Tasks are keyed by claudeSessionId (stable across hub restarts), persisted
// to ~/.config/console/agent-cron.json, scheduled with `croner`, and fired by
// injecting a user_prompt into the target session — same path the hub already
// uses for the post-restart "Continue." nudge (see server/src/index.ts shutdown
// restore loop).
// ============================================================================

import { Cron } from 'croner'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Session } from '../session.js'
import type { HubMessage } from '../protocol.js'

const execFileP = promisify(execFile)

export interface HubCronTask {
  id: string
  claudeSessionId: string
  trigger: string
  recurring: boolean
  prompt: string
  createdAt: number
  lastFiredAt?: number
  lastSkipReason?: string
  consecutiveSkips: number
  disabledAt?: number
}

interface State {
  tasks: HubCronTask[]
  icsToken: string
}

const MAX_SKIPS_BEFORE_DISABLE = 10
const SAVE_DEBOUNCE_MS = 500

function newId(): string {
  // 8 chars base32 — same shape Claude uses for cron task IDs
  return randomBytes(5).toString('base64url').slice(0, 8)
}

export class HubCronScheduler {
  private state: State = { tasks: [], icsToken: '' }
  private jobs = new Map<string, Cron>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private publicBaseCache: { url: string | null } | null = null
  private publicBaseExpiry = 0

  constructor(
    private file: string,
    private getSessions: () => Map<string, Session>,
    private broadcast: (msg: HubMessage) => void,
    private log: (m: string) => void = () => {},
  ) {
    this.load()
  }

  start(): void {
    for (const t of this.state.tasks) {
      if (!t.disabledAt) this.scheduleJob(t)
    }
    this.log(`[cron] scheduled ${this.jobs.size} task(s) of ${this.state.tasks.length} persisted`)
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.persistSync()
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  list(filter?: { claudeSessionId?: string }): HubCronTask[] {
    if (!filter?.claudeSessionId) return [...this.state.tasks]
    return this.state.tasks.filter((t) => t.claudeSessionId === filter.claudeSessionId)
  }

  add(input: { claudeSessionId: string; trigger: string; prompt: string; recurring: boolean }): HubCronTask {
    if (!input.claudeSessionId) throw new Error('claudeSessionId is required')
    if (!input.prompt?.trim()) throw new Error('prompt is required')
    // Validate the trigger by attempting to construct a Cron — throws on bad input
    try { new Cron(input.trigger) } catch (e) {
      throw new Error(`Invalid trigger "${input.trigger}": ${(e as Error).message}`)
    }
    const task: HubCronTask = {
      id: newId(),
      claudeSessionId: input.claudeSessionId,
      trigger: input.trigger,
      recurring: input.recurring,
      prompt: input.prompt,
      createdAt: Date.now(),
      consecutiveSkips: 0,
    }
    this.state.tasks.push(task)
    this.scheduleJob(task)
    this.persistSync()
    return task
  }

  remove(id: string): boolean {
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return false
    this.state.tasks.splice(idx, 1)
    const job = this.jobs.get(id)
    if (job) { job.stop(); this.jobs.delete(id) }
    this.persistSync()
    return true
  }

  /** Manually trigger a task. Same fire path as the scheduled one. */
  runOnce(id: string): { ok: true } | { ok: false; reason: string } {
    const t = this.state.tasks.find((x) => x.id === id)
    if (!t) return { ok: false, reason: 'task not found' }
    return this.fire(t)
  }

  // --------------------------------------------------------------------------
  // ICS / upcoming
  // --------------------------------------------------------------------------

  /** Returns the ICS subscription token, generating + persisting one if absent. */
  getIcsToken(): string {
    if (!this.state.icsToken) {
      this.state.icsToken = randomBytes(16).toString('hex')
      this.persistSync()
    }
    return this.state.icsToken
  }

  /**
   * If a Tailscale Funnel path mapping exists for `/cron.ics → localhost:9877`,
   * return the public base URL (`https://<funnel-host>`). Otherwise null.
   * Cached for 5 minutes — Funnel changes are rare and a stale value still
   * resolves correctly (the path mapping is what's authoritative).
   */
  async getPublicIcsBase(): Promise<string | null> {
    const now = Date.now()
    if (this.publicBaseCache && now < this.publicBaseExpiry) return this.publicBaseCache.url
    let url: string | null = null
    try {
      const { stdout } = await execFileP('tailscale', ['funnel', 'status', '--json'], { timeout: 2000 })
      const status = JSON.parse(stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
      for (const [host, web] of Object.entries(status.Web ?? {})) {
        const handler = web.Handlers?.['/cron.ics']
        if (!handler?.Proxy) continue
        // Match any proxy pointing at our hub port (treat scheme/insecure as opaque).
        if (/localhost:9877/.test(handler.Proxy)) {
          url = `https://${host}`
          break
        }
      }
    } catch {
      // tailscale not installed / not running / not authorized — fall through to null
    }
    this.publicBaseCache = { url }
    this.publicBaseExpiry = now + 5 * 60_000
    return url
  }

  /** Next N upcoming firings per task, capped at `windowMs` from now. */
  upcoming(perTask = 50, windowMs = 30 * 24 * 60 * 60 * 1000): Array<{ task: HubCronTask; fires: Date[] }> {
    const cutoff = new Date(Date.now() + windowMs)
    const out: Array<{ task: HubCronTask; fires: Date[] }> = []
    for (const task of this.state.tasks) {
      if (task.disabledAt) continue
      const job = this.jobs.get(task.id)
      if (!job) continue
      const fires: Date[] = []
      let cursor: Date | undefined
      for (let i = 0; i < perTask; i++) {
        // Croner.nextRun(prev?) returns the next fire AFTER the optional cursor.
        const next = job.nextRun(cursor)
        if (!next || next > cutoff) break
        fires.push(next)
        cursor = next
        if (!task.recurring) break // one-shot has at most one fire
      }
      if (fires.length > 0) out.push({ task, fires })
    }
    return out
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private scheduleJob(task: HubCronTask) {
    try {
      // protect: prevent overlapping fires of the same task while a previous
      // one is still in-flight (Claude may take >1 min to respond on a
      // per-minute cron; without protect we'd queue infinitely).
      const job = new Cron(task.trigger, { protect: true }, () => { void this.fire(task) })
      this.jobs.set(task.id, job)
    } catch (e) {
      this.log(`[cron] failed to schedule ${task.id}: ${(e as Error).message}`)
    }
  }

  private fire(task: HubCronTask): { ok: true } | { ok: false; reason: string } {
    if (task.disabledAt) return { ok: false, reason: 'disabled' }
    const session = [...this.getSessions().values()].find((s) => s.claudeSessionId === task.claudeSessionId)
    if (!session) {
      task.consecutiveSkips++
      task.lastSkipReason = 'session not found'
      if (task.consecutiveSkips >= MAX_SKIPS_BEFORE_DISABLE) {
        task.disabledAt = Date.now()
        this.unscheduleJob(task.id)
      }
      this.persist()
      return { ok: false, reason: 'session not found' }
    }
    if (session.status === 'ended') {
      task.consecutiveSkips++
      task.lastSkipReason = 'session ended'
      if (task.consecutiveSkips >= MAX_SKIPS_BEFORE_DISABLE) {
        task.disabledAt = Date.now()
        this.unscheduleJob(task.id)
      }
      this.persist()
      return { ok: false, reason: 'session ended' }
    }

    // Mirror the "Continue." nudge path: broadcast + log + writeStdin
    const userMsg: HubMessage = { type: 'user_prompt', sessionId: session.id, content: task.prompt }
    this.broadcast(userMsg)
    session.logMessage(userMsg)
    session.sendMessage(task.prompt)

    task.lastFiredAt = Date.now()
    task.consecutiveSkips = 0
    delete task.lastSkipReason

    // One-shot tasks remove themselves after firing
    if (!task.recurring) {
      this.remove(task.id)
      return { ok: true }
    }

    this.persist()
    return { ok: true }
  }

  private unscheduleJob(id: string) {
    const job = this.jobs.get(id)
    if (job) { job.stop(); this.jobs.delete(id) }
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<State>
      this.state.tasks = Array.isArray(raw.tasks) ? raw.tasks : []
      this.state.icsToken = typeof raw.icsToken === 'string' ? raw.icsToken : ''
    } catch (e) {
      this.log(`[cron] load failed: ${(e as Error).message}`)
    }
  }

  private persist(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persistSync()
    }, SAVE_DEBOUNCE_MS)
  }

  private persistSync(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch (e) {
      this.log(`[cron] save failed: ${(e as Error).message}`)
    }
  }
}
