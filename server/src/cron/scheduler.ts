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
import type { PushMessage } from '../push.js'
import { describeWake, wakeOrQueue } from '../agents/wake.js'

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
  /** Stamped synchronously on ENTRY to every fire attempt, before any await —
   *  so an attempt that then throws, skips or queues still leaves a trace.
   *  `lastFiredAt` answers "was the agent woken"; this answers "did the
   *  scheduler run at all". The 2026-09-14 drop was invisible because only
   *  the happy path wrote anything. */
  lastAttemptAt?: number
  /** Human-readable result of the most recent attempt ("fired", "queued
   *  (session mid-turn)", "skipped: session not found", …). */
  lastOutcome?: string
  /** croner's next scheduled fire, refreshed after every (re)schedule and
   *  attempt. Persisted so the missed-fire sweep can judge "this should have
   *  run by now" from state, not from the timer chain it is checking. */
  nextFireAt?: number
  /** Transient (never persisted): the current fire's captured guard stdout,
   *  set by runGuard and consumed by fire when composing the wake prompt. */
  guardOutput?: string
}

interface State {
  tasks: HubCronTask[]
  icsToken: string
}

type FireResult = { ok: true } | { ok: false; reason: string }

const MAX_SKIPS_BEFORE_DISABLE = 10
/** Warn well before auto-disable so a dead session can be revived in time. */
const SKIPS_BEFORE_WARN = 3
const SAVE_DEBOUNCE_MS = 500
/** Wall-clock cap for a guard script. A hung guard must not wedge the fire. */
const GUARD_TIMEOUT_MS = 60_000
/** Cap on guard stdout appended to the wake prompt (chars). */
const GUARD_OUTPUT_CAP = 4000
/** How often the missed-fire sweep runs. */
const SWEEP_INTERVAL_MS = 60_000
/** Slack after `nextFireAt` before an un-attempted fire counts as missed:
 *  croner re-checks its timers every ≤30 s, and a blocked event loop delays
 *  the sweep and the job alike. */
const MISSED_FIRE_GRACE_MS = 90_000
/** A one-shot found overdue (hub down across its time, or its fire dropped)
 *  is delivered late rather than lost — the agent asked to be woken. Give
 *  the session restore loop time to repopulate `getSessions()` first. */
const OVERDUE_ONESHOT_DELAY_MS = 30_000
/** …unless it is this late, in which case waking an agent about something
 *  a day old is noise: record the miss and disable it instead. */
const OVERDUE_ONESHOT_MAX_MS = 24 * 60 * 60 * 1000

function newId(): string {
  // 8 chars base32 — same shape Claude uses for cron task IDs
  return randomBytes(5).toString('base64url').slice(0, 8)
}

export class HubCronScheduler {
  private state: State = { tasks: [], icsToken: '' }
  private jobs = new Map<string, Cron>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private publicBaseCache: { url: string | null } | null = null
  private publicBaseExpiry = 0

  constructor(
    private file: string,
    private getSessions: () => Map<string, Session>,
    private broadcast: (msg: HubMessage) => void,
    private log: (m: string) => void = () => {},
    private notify: (msg: PushMessage) => void = () => {},
  ) {
    this.load()
  }

  start(): void {
    // Judge misses against the PERSISTED nextFireAt before re-arming: a fire
    // the previous hub process should have run (it was down, or dropped it)
    // is recorded here, not silently superseded by a fresh schedule.
    for (const t of this.state.tasks) {
      if (t.disabledAt) continue
      this.checkMissed(t, 'hub was not running')
      if (!t.disabledAt) this.scheduleJob(t)
    }
    this.persist()
    this.log(`[cron] scheduled ${this.jobs.size} task(s) of ${this.state.tasks.length} persisted`)
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
      this.sweepTimer.unref?.()
    }
  }

  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    this.flush()
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.persistSync()
  }

  /** Missed-fire watchdog. croner drives each task from its own setTimeout
   *  chain and tells nobody when a link goes missing: on 2026-09-14 a weekly
   *  task's fire vanished (no wake, no skip, no throw) while two other tasks
   *  on the identical trigger fired that same second. This is the one path
   *  that can notice: any active task whose persisted `nextFireAt` is past
   *  the grace with no attempt stamped since is recorded as a skip — it IS
   *  one — and its job re-armed so a dead chain does not stay dead. Runs
   *  every SWEEP_INTERVAL_MS; public so tests and `runOnce`-style tooling
   *  can drive it. Returns the tasks it caught. */
  sweep(): HubCronTask[] {
    const caught: HubCronTask[] = []
    for (const t of this.state.tasks) {
      if (t.disabledAt) continue
      if (!this.checkMissed(t, 'scheduler never ran it')) continue
      caught.push(t)
      if (!t.disabledAt) this.scheduleJob(t)
    }
    if (caught.length) this.persist()
    return caught
  }

  private checkMissed(task: HubCronTask, why: string): boolean {
    const due = task.nextFireAt
    if (!due || Date.now() < due + MISSED_FIRE_GRACE_MS) return false
    if ((task.lastAttemptAt ?? 0) >= due) return false
    this.skipOutsideFire(task, `missed fire due ${new Date(due).toISOString()} — ${why}`)
    return true
  }

  /** A skip decided outside fire() (missed slot, protect overlap) still gets
   *  the same outcome + log line a fire would have written. */
  private skipOutsideFire(task: HubCronTask, reason: string): void {
    this.recordSkip(task, reason)
    task.lastOutcome = `skipped: ${reason}`
    this.log(`[cron] ${task.id} ${task.lastOutcome}`)
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

  get(id: string): HubCronTask | undefined {
    return this.state.tasks.find((t) => t.id === id)
  }

  /** Remove a task. Every removal is logged with its actor — the 2026-09-11
   *  loss of the weekly mobile sweep (another session bulk-removed every task
   *  whose prompt contained "merge") was invisible because nothing logged it.
   *  A removal by someone other than the owning session also wakes that
   *  session with a one-line notice, so the owner can re-register. */
  remove(id: string, opts: { actor?: string; reason?: string } = {}): boolean {
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return false
    const [task] = this.state.tasks.splice(idx, 1)
    const job = this.jobs.get(id)
    if (job) { job.stop(); this.jobs.delete(id) }
    this.persistSync()
    const actor = opts.actor ?? 'unknown'
    const owner = task!.claudeSessionId.slice(0, 8)
    const promptHint = task!.prompt.length > 70 ? `${task!.prompt.slice(0, 70)}…` : task!.prompt
    this.log(`[cron] removed ${id} (owner ${owner}, ${task!.recurring ? task!.trigger : 'one-shot'}) by ${actor}${opts.reason ? ` — ${opts.reason}` : ''}: "${promptHint.replace(/\n/g, ' ')}"`)
    if (opts.reason !== 'fired') this.notifyOwnerOfRemoval(task!, actor)
    return true
  }

  /** Cross-session removals are the dangerous case: tell the owning session
   *  what happened (same wake path as a fire, so it can act) and push. A
   *  session removing its OWN task gets nothing — that is routine hygiene. */
  private notifyOwnerOfRemoval(task: HubCronTask, actor: string): void {
    const session = [...this.getSessions().values()].find((s) => s.claudeSessionId === task.claudeSessionId)
    const selfRemoval = !!session && (session.agentKey === actor || session.id === actor || session.claudeSessionId === actor)
    if (selfRemoval || actor === 'hub') return
    const byAgent = actor !== 'unknown'
    const promptHint = task.prompt.length > 120 ? `${task.prompt.slice(0, 120)}…` : task.prompt
    if (byAgent) {
      this.notifySafe({
        type: 'agent',
        id: `cron:${task.id}`,
        title: `Cron task removed by ${actor}`,
        body: `${session?.name ?? task.claudeSessionId.slice(0, 8)}'s "${promptHint.replace(/\n/g, ' ')}" (${task.recurring ? task.trigger : 'one-shot'}) is gone.`,
        pane: 'agents',
      })
    }
    if (!session || session.status === 'ended') return
    const who = byAgent
      ? `another agent (**${actor}**) — most likely a mistake on their side. Verify you still need it and re-register with \`con cron add\` if so`
      : 'a human client (SPA or a CLI call without an agent key) — treat that as intentional: note it, do NOT re-add unless Yousef asks'
    const content = `[HUB CRON REMOVED]\nYour hub cron task \`${task.id}\` (trigger \`${task.trigger}\`${task.recurring ? ', recurring' : ', one-shot'}${task.guard ? `, guard \`${task.guard}\`` : ''}) was removed by ${who}. Its prompt was:\n\n${task.prompt}`
    try {
      const userMsg: HubMessage = { type: 'user_prompt', sessionId: session.id, content }
      this.broadcast(userMsg)
      session.logMessage(userMsg)
      session.sendMessage(content)
    } catch (e) {
      this.log(`[cron] owner notice failed: ${(e as Error).message}`)
    }
  }

  /** Re-key every ACTIVE (non-disabled) task from one claudeSessionId to another.
   *  Used when a child session is merged into its parent — the parent absorbs the
   *  child's live crons instead of letting them orphan (and auto-disable after
   *  MAX_SKIPS_BEFORE_DISABLE "session not found" misses) when the child dies.
   *  The Cron jobs themselves keep running untouched: each closes over its task
   *  OBJECT, which we mutate in place, so only the session the fire resolves to
   *  changes. Skip counters reset — a fresh owner shouldn't inherit the child's
   *  miss streak. Returns the tasks that moved. */
  reassignSession(fromClaudeSessionId: string, toClaudeSessionId: string): HubCronTask[] {
    if (!fromClaudeSessionId || !toClaudeSessionId || fromClaudeSessionId === toClaudeSessionId) return []
    const moved: HubCronTask[] = []
    for (const t of this.state.tasks) {
      if (t.claudeSessionId !== fromClaudeSessionId || t.disabledAt) continue
      t.claudeSessionId = toClaudeSessionId
      t.consecutiveSkips = 0
      delete t.lastSkipReason
      moved.push(t)
    }
    if (moved.length) this.persistSync()
    return moved
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
    this.unscheduleJob(task.id)
    try {
      const job = this.buildJob(task, task.trigger)
      let next = job.nextRun()
      if (!next && !task.recurring) {
        // An ISO one-shot whose time has passed: croner arms no timer and
        // the task would sit in the list forever, never firing, never
        // failing. Deliver it late (the agent asked to be woken) unless it
        // is a day stale, in which case record + disable.
        const once = job.getOnce()
        const overdueMs = once ? Date.now() - once.getTime() : Infinity
        job.stop()
        if (overdueMs > OVERDUE_ONESHOT_MAX_MS) {
          task.lastSkipReason = `one-shot ${Math.round(overdueMs / 3_600_000)}h overdue — not delivered`
          task.lastOutcome = `skipped: ${task.lastSkipReason}`
          task.disabledAt = Date.now()
          delete task.nextFireAt
          this.log(`[cron] ${task.id} ${task.lastOutcome}`)
          return
        }
        const late = this.buildJob(task, new Date(Date.now() + OVERDUE_ONESHOT_DELAY_MS))
        next = late.nextRun()
        this.jobs.set(task.id, late)
        task.nextFireAt = next?.getTime()
        this.log(`[cron] ${task.id} one-shot overdue by ${Math.round(overdueMs / 1000)}s — firing in ${OVERDUE_ONESHOT_DELAY_MS / 1000}s`)
        return
      }
      this.jobs.set(task.id, job)
      task.nextFireAt = next?.getTime()
    } catch (e) {
      this.log(`[cron] failed to schedule ${task.id}: ${(e as Error).message}`)
    }
  }

  private buildJob(task: HubCronTask, trigger: string | Date): Cron {
    return new Cron(trigger, {
      // croner honours `protect` only while the callback's RETURNED promise
      // is pending. The old callback `void`ed fire(), so it "finished" on the
      // spot and protect never blocked anything. Returning the promise makes
      // it real (an overlap is now only possible when a guard outlives a
      // per-minute trigger), and the callback form records the overlap
      // instead of dropping the fire silently.
      protect: () => { this.skipOutsideFire(task, 'previous fire still in flight') },
    }, async () => { await this.fire(task) })
  }

  /** One attempt, whatever happens: `lastAttemptAt` is stamped before the
   *  first await and the outcome is written on EVERY path — including a
   *  throw, which used to escape into a `void`ed promise and leave the task
   *  untouched (no lastFiredAt, no skip, no push: the 2026-09-14 drop). */
  private async fire(task: HubCronTask): Promise<FireResult> {
    if (task.disabledAt) return { ok: false, reason: 'disabled' }
    task.lastAttemptAt = Date.now()
    let result: FireResult
    try {
      result = await this.attempt(task)
    } catch (e) {
      result = this.recordSkip(task, `fire threw: ${(e as Error).message}`)
    }
    if (!result.ok) task.lastOutcome = `skipped: ${result.reason}`
    task.nextFireAt = this.jobs.get(task.id)?.nextRun()?.getTime()
    this.log(`[cron] ${task.id} ${task.lastOutcome}`)
    this.persist()
    return result
  }

  private async attempt(task: HubCronTask): Promise<FireResult> {
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
        return { ok: false, reason: task.lastSkipReason }
      }
      task.lastGuardResult = 'fired'
      // Guard passed — its stdout becomes context for the agent.
      task.guardOutput = g.output
    }

    const session = [...this.getSessions().values()].find((s) => s.claudeSessionId === task.claudeSessionId)
    if (!session) return this.recordSkip(task, 'session not found')
    if (session.status === 'ended') return this.recordSkip(task, 'session ended')

    // Compose the wake prompt: the task prompt, plus the guard's stdout as
    // context when present (so the agent sees WHAT the guard detected).
    const guardOut = task.guardOutput
    const content = guardOut
      ? `${task.prompt}\n\n--- guard output (\`${task.guard}\`) ---\n${guardOut}`
      : task.prompt
    delete task.guardOutput

    task.lastOutcome = describeWake(wakeOrQueue(session, content, this.broadcast))

    task.lastFiredAt = Date.now()
    task.consecutiveSkips = 0
    delete task.lastSkipReason

    // One-shot tasks remove themselves after firing
    if (!task.recurring) this.remove(task.id, { actor: 'hub', reason: 'fired' })
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

  /** A skip = the fire could not be delivered: session gone, fire threw,
   *  previous fire still in flight, or the timer chain missed the slot (guard
   *  no-changes deliberately do NOT come through here — they never count
   *  toward auto-disable). Warns once at SKIPS_BEFORE_WARN so a dead session
   *  can be revived before the task auto-disables, and alerts on the disable
   *  itself. */
  private recordSkip(task: HubCronTask, reason: string): { ok: false; reason: string } {
    task.consecutiveSkips++
    task.lastSkipReason = reason
    const promptHint = task.prompt.length > 60 ? `${task.prompt.slice(0, 60)}…` : task.prompt
    if (task.consecutiveSkips === SKIPS_BEFORE_WARN) {
      this.notifySafe({
        type: 'agent',
        id: `cron:${task.id}`,
        title: `Cron task skipping (${task.consecutiveSkips}×)`,
        body: `"${promptHint}" — ${reason}. Auto-disables after ${MAX_SKIPS_BEFORE_DISABLE} skips.`,
        pane: 'agents',
      })
    }
    if (task.consecutiveSkips >= MAX_SKIPS_BEFORE_DISABLE) {
      task.disabledAt = Date.now()
      this.unscheduleJob(task.id)
      this.notifySafe({
        type: 'agent',
        id: `cron:${task.id}`,
        title: 'Cron task auto-disabled',
        body: `"${promptHint}" disabled after ${task.consecutiveSkips} skips (${reason}). Re-add with \`con cron add\`.`,
        pane: 'agents',
      })
      this.log(`[cron] auto-disabled ${task.id} after ${task.consecutiveSkips} skips (${reason})`)
    }
    this.persist()
    return { ok: false, reason }
  }

  private notifySafe(msg: PushMessage): void {
    try {
      this.notify(msg)
    } catch (e) {
      this.log(`[cron] notify failed: ${(e as Error).message}`)
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
