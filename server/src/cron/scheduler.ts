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
  /** Optional shell guard. When set, the scheduler runs it at each trigger and
   *  only wakes the agent when it exits 0 (a non-zero exit = "nothing to do",
   *  skipped silently — no tokens spent). Its stdout (trimmed, capped) is
   *  appended to the prompt so the agent knows WHAT changed. Runs via
   *  `bash -c` in the session's cwd (or home), `GUARD_TIMEOUT_MS` cap. This is
   *  the token-free polling primitive: e.g. a script that diffs a URL and exits
   *  0 only on change. */
  guard?: string
  createdAt: number
  lastFiredAt?: number
  /** Last time the guard ran (fired or skipped) — distinct from lastFiredAt,
   *  which only advances when the agent was actually woken. */
  lastCheckedAt?: number
  /** Outcome of the most recent guard evaluation, for the UI/inspection. */
  lastGuardResult?: 'fired' | 'skipped' | 'error'
  lastSkipReason?: string
  consecutiveSkips: number
  disabledAt?: number
  /** Transient (never persisted): the current fire's captured guard stdout,
   *  set by runGuard and consumed by fire when composing the wake prompt. */
  guardOutput?: string
}

interface State {
  tasks: HubCronTask[]
  icsToken: string
}

const MAX_SKIPS_BEFORE_DISABLE = 10
const SAVE_DEBOUNCE_MS = 500
/** Wall-clock cap for a guard script. A hung guard must not wedge the fire. */
const GUARD_TIMEOUT_MS = 60_000
/** Cap on guard stdout appended to the wake prompt (chars). */
const GUARD_OUTPUT_CAP = 4000

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

  add(input: { claudeSessionId: string; trigger: string; prompt: string; recurring: boolean; guard?: string }): HubCronTask {
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
      ...(input.guard?.trim() ? { guard: input.guard.trim() } : {}),
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

  /** Manually trigger a task. Same fire path as the scheduled one (runs the
   *  guard too — a manual run of a guarded task only wakes the agent if the
   *  guard passes, exactly like a scheduled fire). */
  async runOnce(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
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
   * Public base URL for the cron ICS feed. Defaults to the same `con.amar.io`
   * origin the rest of the public surface uses; override via the
   * `CONSOLE_PUBLIC_ORIGIN` env var. Returns null only when explicitly
   * disabled — Google Calendar etc. will be told to use the URL we return
   * verbatim, so it has to be reachable from the public internet.
   */
  async getPublicIcsBase(): Promise<string | null> {
    return (process.env.CONSOLE_PUBLIC_ORIGIN || 'https://con.amar.io').replace(/\/$/, '')
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

  private async fire(task: HubCronTask): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (task.disabledAt) return { ok: false, reason: 'disabled' }

    // Guard gate: run the script FIRST (cheap, token-free). Only proceed to
    // wake the agent when it exits 0. A non-zero exit is the normal
    // "nothing to do" case — skip silently, keep the task scheduled, and do
    // NOT count it toward the auto-disable skip budget (a guard that says "no
    // change" for months is working correctly, not failing).
    if (task.guard) {
      const g = await this.runGuard(task)
      task.lastCheckedAt = Date.now()
      if (!g.proceed) {
        task.lastGuardResult = g.error ? 'error' : 'skipped'
        task.lastSkipReason = g.error ? `guard error: ${g.error}` : 'guard: no change'
        this.persist()
        return { ok: false, reason: task.lastSkipReason }
      }
      task.lastGuardResult = 'fired'
      // Guard passed — its stdout becomes context for the agent.
      task.guardOutput = g.output
    }

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

    // Compose the wake prompt: the task prompt, plus the guard's stdout as
    // context when present (so the agent sees WHAT the guard detected).
    const guardOut = task.guardOutput
    const content = guardOut
      ? `${task.prompt}\n\n--- guard output (\`${task.guard}\`) ---\n${guardOut}`
      : task.prompt
    delete task.guardOutput

    // Mirror the "Continue." nudge path: broadcast + log + writeStdin
    const userMsg: HubMessage = { type: 'user_prompt', sessionId: session.id, content }
    this.broadcast(userMsg)
    session.logMessage(userMsg)
    session.sendMessage(content)

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

  /** Run a task's guard script. Resolves { proceed } — true only on exit 0.
   *  Executed via `bash -c` in the session's cwd (falls back to $HOME), with a
   *  hard timeout. stdout is captured (trimmed + capped) for the wake prompt. */
  private async runGuard(task: HubCronTask): Promise<{ proceed: boolean; output?: string; error?: string }> {
    const session = [...this.getSessions().values()].find((s) => s.claudeSessionId === task.claudeSessionId)
    const cwd = session?.cwd || process.env.HOME || process.cwd()
    try {
      const { stdout } = await execFileP('bash', ['-c', task.guard!], {
        cwd,
        timeout: GUARD_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      })
      const out = stdout.trim().slice(0, GUARD_OUTPUT_CAP)
      return { proceed: true, output: out || undefined }
    } catch (e) {
      const err = e as { code?: number; killed?: boolean; signal?: string; message?: string }
      // Non-zero exit is the EXPECTED "no change / nothing to do" signal — not
      // an error. A timeout/spawn failure IS an error (surfaced, but still just
      // skips the fire — never wakes the agent on a broken guard).
      if (typeof err.code === 'number' && !err.killed) return { proceed: false }
      return { proceed: false, error: err.killed ? `timed out after ${GUARD_TIMEOUT_MS}ms` : (err.message ?? 'guard failed to run') }
    }
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
      // Strip the transient guardOutput — it's per-fire context, not state.
      const persisted = {
        ...this.state,
        tasks: this.state.tasks.map(({ guardOutput, ...t }) => t),
      }
      writeFileSync(this.file, JSON.stringify(persisted, null, 2))
    } catch (e) {
      this.log(`[cron] save failed: ${(e as Error).message}`)
    }
  }
}
