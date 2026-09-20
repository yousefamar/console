// ListenerEngine — subscribes to the bus and walks each rule down the cost
// ladder. Every IO seam is injected. State lives in ListenerStore; the only
// in-memory state is the per-listener timer, re-derived from `pending` on
// start. Delivery is at-least-once: a batch is journaled `firing` before the
// guard/action run, and a `firing` entry with no successor after a restart
// is re-run.

import type { EventBus } from '../events/bus.js'
import { topicMatches, type HubEvent } from '../events/types.js'
import type { Session } from '../session.js'
import type { HubMessage } from '../protocol.js'
import type { PushMessage } from '../push.js'
import { describeWake, findByClaudeSessionId, wakeOrQueue } from '../agents/wake.js'
import { ListenerStore } from './store.js'
import { inWindow, nextWindowStart, parseDays, parseHours, parseWhere, whereMatches, pathGet, formatWhere } from './matcher.js'
import { runShell, type ShellRunner } from './shell.js'
import {
  DEFAULT_COALESCE_WAKE_MS, DEFAULT_MAX_PER_HOUR, DEFAULT_MAX_PER_HOUR_WAKE, EXPIRY_SWEEP_MS, GUARD_OUTPUT_CAP, GUARD_TIMEOUT_MS,
  MAX_BATCH, MAX_OUTCOMES, MAX_SKIPS_BEFORE_DISABLE, OVERDUE_PENDING_MAX_MS, RUN_TIMEOUT_MS, SKIPS_BEFORE_WARN,
  type Listener, type ListenerAction, type ListenerOwner, type Outcome, type WhereClause,
} from './types.js'

export interface ListenerEngineCtx {
  bus: EventBus
  store: ListenerStore
  getSessions: () => Map<string, Session>
  liveSessionForKey: (agentKey: string) => Session | undefined
  broadcast: (msg: HubMessage) => void
  notify: (msg: PushMessage) => void
  addCard?: (project: string, text: string, opts: { column?: string; agentKey?: string }) => Promise<string>
  postUrl?: (url: string, body: string, headers: Record<string, string>, method: string) => Promise<{ ok: boolean; detail: string }>
  /** `--fork`: mint a FRESH session beside `source` (same cwd/project, source is the parent) to take one wake. Null when the source has no csid yet. */
  spawnFork?: (source: Session, l: Listener, model?: string) => Session | null
  /** Close a listener fork whose turn is over. */
  closeFork?: (fork: Session) => void
  shell?: ShellRunner
  log: (msg: string) => void
  now?: () => number
}

export interface AddListenerInput {
  owner: ListenerOwner
  on: string
  where?: string[]
  guard?: string
  coalesce?: number
  cooldown?: number
  hours?: string
  days?: string
  dropOutside?: boolean
  maxPerHour?: number
  name?: string
  /** Self-remove after this many fires (`--once` = 1). */
  times?: number
  /** Self-remove at this epoch ms regardless. */
  expiresAt?: number
  action: ListenerAction
}

export interface TestResult {
  stage: 'no-match' | 'where' | 'window' | 'cooldown' | 'paused' | 'guard' | 'would-fire'
  detail: string
  envelope?: string
}

const ONE_HOUR = 3_600_000
const FORK_SETTLE_MS = 2_000
const FORK_IDLE_CAP_MS = 30 * 60_000

async function defaultPost(url: string, body: string, headers: Record<string, string>, method: string): Promise<{ ok: boolean; detail: string }> {
  const delays = [0, 2_000, 5_000]
  let last = ''
  for (const d of delays) {
    if (d) await new Promise((r) => setTimeout(r, d))
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'console-hub-listener/1', ...headers }, body, signal: ctrl.signal })
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}` }
      last = `HTTP ${res.status}`
      if (res.status < 500) break
    } catch (err) {
      last = (err as Error).message
    } finally {
      clearTimeout(t)
    }
  }
  return { ok: false, detail: last }
}

/** `{{data.subject}}` → the first event's value; unknown paths become ''. */
export function template(text: string, ev: HubEvent | undefined): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g, (_, path: string) => {
    const v = ev ? pathGet(ev, path) : undefined
    return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  })
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '')
}

function summariseEvent(ev: HubEvent): string {
  const d = ev.data
  const parts = Object.entries(d).slice(0, 6).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return `${k}: ${s.length > 120 ? `${s.slice(0, 117)}…` : s}`
  })
  return parts.join(' · ')
}

/** Facts first, the ask last — the [WEBHOOK] and [GEOFENCE] envelope shape. */
export function buildEventEnvelope(l: Listener, events: HubEvent[], guardOutput?: string): string {
  const lines: string[] = []
  const topics = [...new Set(events.map((e) => e.topic))].join(', ')
  lines.push(`[EVENT — ${topics}${events.length > 1 ? ` ×${events.length} coalesced` : ''}] Listener ${l.id}${l.name ? ` ("${l.name}")` : ''} fired. Nothing has acted on ${events.length > 1 ? 'these' : 'this'}.`)
  events.forEach((ev, i) => {
    lines.push(`${events.length > 1 ? `${i + 1}. ` : ''}${fmtWhen(ev.at)} · ${ev.topic} · ${summariseEvent(ev)}${ev.ref ? ` · ref: ${ev.ref}` : ''} · id ${ev.id}`)
  })
  if (guardOutput) {
    lines.push(`--- guard output (\`${l.guard}\`) ---`)
    lines.push(guardOutput)
  }
  lines.push(`Full events: \`con event show <id>\` · this listener: \`con listen show ${l.id}\` · pause it: \`con listen pause ${l.id}\`.`)
  return lines.join('\n')
}

/** What a `--fork` wake's fresh session must know about itself: it is a
 *  throwaway fork of the target, its argv names its csid (twin-delivery check,
 *  same as a ticket-fork), and it ends with this turn — so anything Yousef or
 *  the parent must see leaves via a card, notification, emit or the ping. */
export function buildForkIdentity(fork: Pick<Session, 'agentKey' | 'claudeSessionId'>, source: Pick<Session, 'name' | 'agentKey' | 'cwd'>, l: Listener): string {
  return [
    `[LISTENER FORK] You are a fresh, single-turn fork of "${source.name ?? source.agentKey ?? 'the owner'}"${source.agentKey ? ` (@${source.agentKey})` : ''} spawned by listener ${l.id}${l.name ? ` ("${l.name}")` : ''} for the event below. Your agentKey is \`${fork.agentKey}\`; your claudeSessionId is \`${fork.claudeSessionId}\` (\`ps -o args= -p $PPID\` shows \`--session-id ${fork.claudeSessionId}\` — if it does not, this wake reached the wrong process: say so and stop).`,
    `You run from ${source.cwd} (its CLAUDE.md and auto-memory are yours). The parent's conversation is NOT in your context, and nothing you write reaches it. This session is closed when your turn ends: do the whole job now, and route anything that must outlive you through a board card, \`con event emit\`, a notification, a file, or a chat draft.`,
  ].join('\n')
}

export function describeAction(a: ListenerAction): string {
  switch (a.type) {
    case 'wake': return `wake${a.fork ? ` (fork${a.model ? ` ${a.model}` : ''})` : ''}${a.as ? ` @${a.as}` : ''}: ${a.prompt.length > 60 ? `${a.prompt.slice(0, 57)}…` : a.prompt}`
    case 'run': return `run: ${a.cmd}`
    case 'post': return `post ${a.method ?? 'POST'} ${a.url}`
    case 'notify': return `notify: ${a.title}`
    case 'emit': return `emit ${a.topic}`
    case 'card': return `card ${a.project}: ${a.text.slice(0, 60)}`
  }
}

export class ListenerEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly shell: ShellRunner
  private readonly post: NonNullable<ListenerEngineCtx['postUrl']>

  constructor(private readonly ctx: ListenerEngineCtx) {
    this.shell = ctx.shell ?? runShell
    this.post = ctx.postUrl ?? defaultPost
  }

  private now(): number { return this.ctx.now ? this.ctx.now() : Date.now() }
  private get store(): ListenerStore { return this.ctx.store }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    this.unsubscribe ??= this.ctx.bus.subscribe('*', (ev) => this.onEvent(ev))
    const now = this.now()
    for (const l of this.store.listeners) {
      if (l.disabledAt) continue
      // Interrupted batches: `firing` with nothing after it means the guard or
      // action never finished — re-run (at-least-once).
      const last = l.outcomes[l.outcomes.length - 1]
      if (last && last.stage === 'firing') {
        this.ctx.log(`[listeners] ${l.id} re-running batch interrupted by a restart (${last.events.length} event(s))`)
        last.stage = 'error'
        last.detail = 'interrupted by hub restart — re-run'
        void this.runBatch(l, last.events, 'restart')
      }
      if (l.pending) {
        if (now - l.pending.startedAt > OVERDUE_PENDING_MAX_MS) {
          this.record(l, 'dropped', l.pending.events, `pending batch ${Math.round((now - l.pending.startedAt) / ONE_HOUR)} h stale after downtime — not delivered`)
          delete l.pending
        } else {
          l.pending.dueAt = Math.min(l.pending.dueAt, now + 1_000)
          this.arm(l)
        }
      }
    }
    this.sweepExpired()
    this.store.persist()
    this.ctx.log(`[listeners] ${this.store.listeners.filter((l) => !l.disabledAt && !l.pausedAt).length} active of ${this.store.listeners.length}`)
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), EXPIRY_SWEEP_MS)
      this.sweepTimer.unref?.()
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.store.flush()
  }

  /** Remove every listener whose `expiresAt` has passed. Also run per event so an
   *  expired one never fires between sweeps. Returns what went. */
  sweepExpired(): Listener[] {
    const now = this.now()
    const gone = this.store.listeners.filter((l) => l.expiresAt !== undefined && l.expiresAt <= now)
    for (const l of gone) {
      this.record(l, 'expired', l.pending?.events ?? [], `expired ${fmtWhen(l.expiresAt!)} after ${l.stats.fired} fire(s)`)
      this.remove(l.id, { actor: 'hub', reason: `expired after ${l.stats.fired} fire(s)${l.pending?.events.length ? `, ${l.pending.events.length} event(s) still pending` : ''}` })
    }
    return gone
  }

  // ── CRUD ───────────────────────────────────────────────────────────────

  list(filter?: { claudeSessionId?: string; topic?: string }): Listener[] {
    return this.store.listeners.filter((l) =>
      (!filter?.claudeSessionId || l.owner.claudeSessionId === filter.claudeSessionId)
      && (!filter?.topic || l.on === filter.topic))
  }

  get(id: string): Listener | undefined { return this.store.get(id) }

  /** Ids of the listeners whose topic + where match this event (paused ones
   *  included — they hold it; disabled ones excluded). Pure; the webhook
   *  pipeline uses it to decide whether the owner-wake fallback still runs. */
  matching(ev: HubEvent): string[] {
    return this.store.listeners
      .filter((l) => !l.disabledAt && ev.source !== `listener:${l.id}` && topicMatches(l.on, ev.topic) && whereMatches(ev, l.where))
      .map((l) => l.id)
  }

  add(input: AddListenerInput): Listener {
    if (!input.owner?.claudeSessionId) throw new Error('owner.claudeSessionId is required')
    const on = input.on?.trim()
    if (!on || !/^[a-z*][a-z0-9*]*(\.[a-z0-9_*-]+)*$/.test(on)) throw new Error(`bad topic pattern "${input.on}" — e.g. chat.message, geo.*, astera.release`)
    const where: WhereClause[] = (input.where ?? []).map(parseWhere)
    if (input.hours) parseHours(input.hours)
    if (input.days) parseDays(input.days)
    const action = validateAction(input.action)
    const isWake = action.type === 'wake'
    if (input.times !== undefined && (!Number.isInteger(input.times) || input.times < 1)) throw new Error('--times must be a whole number ≥ 1 (--once = 1)')
    if (input.expiresAt !== undefined && !(input.expiresAt > this.now())) throw new Error('--expires must be in the future')
    const l: Listener = {
      id: this.store.mintId(),
      ...(input.name ? { name: input.name } : {}),
      owner: input.owner,
      createdAt: this.now(),
      on,
      where,
      ...(input.guard?.trim() ? { guard: input.guard.trim() } : {}),
      coalesceMs: input.coalesce ?? (isWake ? DEFAULT_COALESCE_WAKE_MS : 0),
      cooldownMs: input.cooldown ?? 0,
      ...(input.hours ? { hours: input.hours } : {}),
      ...(input.days ? { days: input.days } : {}),
      ...(input.dropOutside ? { dropOutside: true } : {}),
      maxPerHour: input.maxPerHour ?? (isWake ? DEFAULT_MAX_PER_HOUR_WAKE : DEFAULT_MAX_PER_HOUR),
      action,
      ...(input.times !== undefined ? { times: input.times, timesTotal: input.times } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      consecutiveSkips: 0,
      stats: { matched: 0, fired: 0, guardSkipped: 0 },
      firedAt: [],
      outcomes: [],
    }
    this.store.listeners.push(l)
    this.store.persistSync()
    this.ctx.log(`[listeners] added ${l.id} on ${l.on}${where.length ? ` where ${where.map(formatWhere).join(' && ')}` : ''} → ${describeAction(action)} (owner ${l.owner.agentKey ?? l.owner.claudeSessionId.slice(0, 8)}${l.times ? `, ${l.times === 1 ? 'once' : `${l.times}×`}` : ''}${l.expiresAt ? `, expires ${fmtWhen(l.expiresAt)}` : ''})`)
    return l
  }

  remove(id: string, opts: { actor?: string; reason?: string } = {}): boolean {
    const idx = this.store.listeners.findIndex((l) => l.id === id)
    if (idx === -1) return false
    const [l] = this.store.listeners.splice(idx, 1)
    this.disarm(id)
    this.store.persistSync()
    this.ctx.log(`[listeners] removed ${id} (owner ${l!.owner.agentKey ?? l!.owner.claudeSessionId.slice(0, 8)}, on ${l!.on}) by ${opts.actor ?? 'unknown'}${opts.reason ? ` — ${opts.reason}` : ''}`)
    if (opts.actor && opts.actor !== 'hub') this.notifyOwnerOfRemoval(l!, opts.actor)
    return true
  }

  pause(id: string, reason = 'paused by request'): Listener | undefined {
    const l = this.store.get(id)
    if (!l) return undefined
    l.pausedAt = this.now()
    l.pauseReason = reason
    this.disarm(id)
    this.store.persistSync()
    return l
  }

  resume(id: string): Listener | undefined {
    const l = this.store.get(id)
    if (!l) return undefined
    delete l.pausedAt
    delete l.pauseReason
    delete l.disabledAt
    l.consecutiveSkips = 0
    l.firedAt = []
    if (l.pending) { l.pending.dueAt = this.now() + 1_000; this.arm(l) }
    this.store.persistSync()
    return l
  }

  reassignSession(from: string, to: string): Listener[] {
    if (!from || !to || from === to) return []
    const moved: Listener[] = []
    for (const l of this.store.listeners) {
      if (l.owner.claudeSessionId !== from || l.disabledAt) continue
      l.owner.claudeSessionId = to
      l.consecutiveSkips = 0
      moved.push(l)
    }
    if (moved.length) this.store.persistSync()
    return moved
  }

  // ── the ladder ─────────────────────────────────────────────────────────

  private onEvent(ev: HubEvent): void {
    const now = this.now()
    if (this.store.listeners.some((l) => l.expiresAt !== undefined && l.expiresAt <= now)) this.sweepExpired()
    for (const l of this.store.listeners) {
      if (l.disabledAt) continue
      if (ev.source === `listener:${l.id}`) continue
      if (!topicMatches(l.on, ev.topic)) continue
      if (!whereMatches(ev, l.where)) continue
      l.stats.matched++
      l.stats.lastEventAt = now
      if (l.dropOutside && !inWindow(now, l.hours, l.days)) {
        this.record(l, 'dropped', [ev.id], 'outside the active window')
        continue
      }
      if (!l.pending) l.pending = { events: [], startedAt: now, dueAt: now }
      if (l.pending.events.length < MAX_BATCH * 4) l.pending.events.push(ev.id)
      l.pending.dueAt = this.dueAt(l, now)
      if (!l.pausedAt) this.arm(l)
    }
    this.store.persist()
  }

  /** When the current pending batch may fire: after the quiet period, the cooldown, and the window opening. */
  private dueAt(l: Listener, now: number): number {
    let due = now + l.coalesceMs
    if (l.cooldownMs && l.stats.lastFiredAt) due = Math.max(due, l.stats.lastFiredAt + l.cooldownMs)
    const open = nextWindowStart(due, l.hours, l.days)
    return open ?? due
  }

  private arm(l: Listener): void {
    this.disarm(l.id)
    if (!l.pending) return
    const delay = Math.max(0, l.pending.dueAt - this.now())
    const t = setTimeout(() => { this.timers.delete(l.id); void this.flushPending(l) }, Math.min(delay, 2_147_000_000))
    t.unref?.()
    this.timers.set(l.id, t)
  }

  private disarm(id: string): void {
    const t = this.timers.get(id)
    if (t) { clearTimeout(t); this.timers.delete(id) }
  }

  /** Timer callback: take the batch off `pending` and run it, or re-arm if a gate says not yet. */
  async flushPending(l: Listener): Promise<void> {
    if (!l.pending || l.disabledAt || l.pausedAt) return
    const now = this.now()
    if (l.expiresAt !== undefined && l.expiresAt <= now) { this.sweepExpired(); return }
    const due = this.dueAt(l, now - l.coalesceMs)
    if (due > now + 500) { l.pending.dueAt = due; this.arm(l); return }
    l.firedAt = l.firedAt.filter((t) => now - t < ONE_HOUR)
    if (l.firedAt.length >= l.maxPerHour) {
      l.pausedAt = now
      l.pauseReason = `ceiling: ${l.firedAt.length} actions in the last hour (max ${l.maxPerHour})`
      this.record(l, 'paused', l.pending.events, l.pauseReason)
      this.ctx.notify({ type: 'agent', id: `listener:${l.id}`, title: `Listener ${l.id} paused`, body: `${l.name ?? l.on}: ${l.pauseReason}. \`con listen resume ${l.id}\` when fixed.`, pane: 'agents' })
      this.ctx.bus.emit({ topic: 'listener.paused', source: 'listeners', data: { listenerId: l.id, firedLastHour: l.firedAt.length, maxPerHour: l.maxPerHour } })
      this.ctx.log(`[listeners] ${l.id} ${l.pauseReason}`)
      this.store.persist()
      return
    }
    const batch = l.pending.events.slice(0, MAX_BATCH)
    const rest = l.pending.events.slice(MAX_BATCH)
    if (rest.length) { l.pending = { events: rest, startedAt: now, dueAt: now + Math.max(l.coalesceMs, 1_000) }; this.arm(l) }
    else delete l.pending
    await this.runBatch(l, batch, 'scheduled')
  }

  /** Guard → action for one batch. Journaled `firing` first so a crash re-runs it. */
  private async runBatch(l: Listener, ids: string[], why: 'scheduled' | 'restart' | 'redeliver'): Promise<Outcome> {
    const outcome = this.record(l, 'firing', ids, why === 'scheduled' ? undefined : why)
    this.store.persistSync()
    const events = ids.map((id) => this.ctx.bus.get(id)).filter((e): e is HubEvent => !!e)
    if (!events.length) return this.finish(l, outcome, 'error', 'events no longer in the log')
    let guardOutput: string | undefined
    if (l.guard) {
      const g = await this.runGuard(l, events)
      if (g.error) return this.finish(l, outcome, 'error', `guard error: ${g.error}`)
      if (!g.proceed) { l.stats.guardSkipped++; return this.finish(l, outcome, 'guard-skipped', g.output ? `guard said no: ${g.output.slice(0, 200)}` : 'guard exited non-zero') }
      guardOutput = g.output
    }
    try {
      const r = await this.act(l, events, guardOutput)
      if (!r.ok) return this.finish(l, outcome, 'skipped', r.detail, true)
      l.stats.fired++
      l.stats.lastFiredAt = this.now()
      l.firedAt.push(l.stats.lastFiredAt)
      l.consecutiveSkips = 0
      this.ctx.bus.emit({ topic: 'listener.fired', source: 'listeners', data: { listenerId: l.id, action: l.action.type, events: ids } })
      const done = this.finish(l, outcome, 'fired', r.detail)
      if (l.times !== undefined) {
        l.times--
        if (l.times <= 0) {
          this.remove(l.id, { actor: 'hub', reason: `fired ${l.timesTotal ?? 1}/${l.timesTotal ?? 1} — self-removed` })
        }
      }
      return done
    } catch (e) {
      return this.finish(l, outcome, 'error', (e as Error).message, true)
    }
  }

  private finish(l: Listener, o: Outcome, stage: Outcome['stage'], detail?: string, countSkip = false): Outcome {
    o.stage = stage
    if (detail) o.detail = detail
    o.at = this.now()
    l.stats.lastOutcome = detail ? `${stage}: ${detail}` : stage
    if (countSkip) this.recordSkip(l, detail ?? stage)
    this.ctx.log(`[listeners] ${l.id} ${l.stats.lastOutcome} (${o.events.length} event(s))`)
    this.store.persist()
    return o
  }

  private record(l: Listener, stage: Outcome['stage'], events: string[], detail?: string): Outcome {
    const o: Outcome = { at: this.now(), stage, events, ...(detail ? { detail } : {}) }
    l.outcomes.push(o)
    if (l.outcomes.length > MAX_OUTCOMES) l.outcomes.splice(0, l.outcomes.length - MAX_OUTCOMES)
    if (stage !== 'firing') l.stats.lastOutcome = detail ? `${stage}: ${detail}` : stage
    return o
  }

  private async runGuard(l: Listener, events: HubEvent[]): Promise<{ proceed: boolean; output?: string; error?: string }> {
    const r = await this.shell(l.guard!, {
      cwd: l.owner.cwd || process.env.HOME || process.cwd(),
      input: JSON.stringify({ listener: { id: l.id, name: l.name ?? null }, events }),
      env: shellEnv(l, events),
      timeoutMs: GUARD_TIMEOUT_MS,
      outputCap: GUARD_OUTPUT_CAP,
    })
    if (r.killed) return { proceed: false, error: `timed out after ${GUARD_TIMEOUT_MS} ms` }
    if (r.code === null) return { proceed: false, error: r.stderr || 'failed to run' }
    const output = r.stdout.trim() || undefined
    return { proceed: r.code === 0, output }
  }

  private async act(l: Listener, events: HubEvent[], guardOutput?: string): Promise<{ ok: boolean; detail: string }> {
    const a = l.action
    const first = events[0]!
    switch (a.type) {
      case 'wake': {
        const session = a.as
          ? this.ctx.liveSessionForKey(a.as)
          : findByClaudeSessionId(this.ctx.getSessions().values(), l.owner.claudeSessionId)
        if (!session) return { ok: false, detail: a.as ? `@${a.as} is not live` : 'session not found' }
        if (session.status === 'ended') return { ok: false, detail: 'session ended' }
        const content = `${buildEventEnvelope(l, events, guardOutput)}\n\n${template(a.prompt, first)}`
        if (a.fork) return this.wakeFork(l, session, content, a.model)
        return { ok: true, detail: `${describeWake(wakeOrQueue(session, content, this.ctx.broadcast))} → ${session.name || session.id}` }
      }
      case 'run': {
        const r = await this.shell(a.cmd, {
          cwd: l.owner.cwd || process.env.HOME || process.cwd(),
          input: JSON.stringify({ listener: { id: l.id, name: l.name ?? null }, events, guardOutput: guardOutput ?? null }),
          env: shellEnv(l, events),
          timeoutMs: RUN_TIMEOUT_MS,
          outputCap: GUARD_OUTPUT_CAP,
        })
        if (r.killed) return { ok: false, detail: `run timed out after ${RUN_TIMEOUT_MS} ms` }
        if (r.code !== 0) return { ok: false, detail: `run exited ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}` }
        return { ok: true, detail: `run ok${r.stdout.trim() ? `: ${r.stdout.trim().slice(0, 200)}` : ''}` }
      }
      case 'post': {
        const body = JSON.stringify({ listener: { id: l.id, name: l.name ?? null }, events, guardOutput: guardOutput ?? null })
        const r = await this.post(a.url, body, { 'X-Console-Event-Id': first.id, 'X-Console-Listener': l.id, ...(a.headers ?? {}) }, a.method ?? 'POST')
        return { ok: r.ok, detail: `post ${a.url} → ${r.detail}` }
      }
      case 'notify': {
        this.ctx.notify({ type: 'generic', id: `listener:${l.id}:${first.id}`, title: template(a.title, first), body: template(a.body ?? summariseEvent(first), first), pane: 'agents' })
        return { ok: true, detail: 'notified' }
      }
      case 'emit': {
        const data: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(a.data ?? {})) data[k] = typeof v === 'string' ? template(v, first) : v
        data.sourceTopic = first.topic
        data.sourceEvents = events.map((e) => e.id)
        if (guardOutput) data.guardOutput = guardOutput
        const out = this.ctx.bus.emitWithOutcome({ topic: a.topic, source: `listener:${l.id}`, data, hops: Math.max(...events.map((e) => e.hops)) + 1 })
        return out.event ? { ok: true, detail: `emitted ${out.event.id}` } : { ok: false, detail: `emit dropped: ${out.dropped}` }
      }
      case 'card': {
        if (!this.ctx.addCard) return { ok: false, detail: 'board not available' }
        const text = template(a.text, first)
        const detail = await this.ctx.addCard(a.project, text, { column: a.column, agentKey: a.assign })
        return { ok: true, detail: `card ${detail}` }
      }
    }
  }

  /** `--fork`: the target's context stays untouched — a fresh session at its
   *  cwd takes the envelope and is closed once its turn ends. The target
   *  itself must still be live (it lends cwd, project and lineage), so the
   *  skip semantics are exactly those of a plain wake. */
  private wakeFork(l: Listener, source: Session, content: string, model?: string): { ok: boolean; detail: string } {
    if (!this.ctx.spawnFork || !this.ctx.closeFork) return { ok: false, detail: 'fork wakes are not wired on this hub' }
    const fork = this.ctx.spawnFork(source, l, model)
    if (!fork) return { ok: false, detail: `cannot fork ${source.name ?? source.id} — it has no claudeSessionId yet` }
    wakeOrQueue(fork, `${buildForkIdentity(fork, source, l)}\n\n${content}`, this.ctx.broadcast)
    this.reapForkAfterTurn(l, fork)
    return { ok: true, detail: `forked → ${fork.name ?? fork.id}${model ? ` on ${model}` : ''} (of ${source.name ?? source.id})` }
  }

  /** Close the fork 2 s after its first `result`. A fork that raised the
   *  attention marker asked for Yousef and stays; one silent for 30 min
   *  (a permission prompt nobody answers) is left alive and logged, never
   *  killed mid-work. */
  private reapForkAfterTurn(l: Listener, fork: Session): void {
    const label = `${l.id} fork ${fork.name ?? fork.id}`
    let cap: ReturnType<typeof setTimeout> | undefined
    const armCap = () => {
      if (cap) clearTimeout(cap)
      cap = setTimeout(() => {
        fork.off('hub_message', onMsg)
        this.ctx.log(`[listeners] ${label}: no result after ${FORK_IDLE_CAP_MS / 60_000} min idle — left alive, close it by hand`)
      }, FORK_IDLE_CAP_MS)
      cap.unref?.()
    }
    const onMsg = (m: HubMessage) => {
      armCap()
      if (m.type !== 'result') return
      fork.off('hub_message', onMsg)
      if (cap) clearTimeout(cap)
      setTimeout(() => {
        if (fork.status === 'ended') return
        if (fork.needsAttention) { this.ctx.log(`[listeners] ${label}: asked for Yousef — left alive`); return }
        this.ctx.closeFork!(fork)
        this.ctx.log(`[listeners] ${label}: turn done ($${m.cost.toFixed(3)}) — closed`)
      }, FORK_SETTLE_MS).unref?.()
    }
    armCap()
    fork.on('hub_message', onMsg)
  }

  // ── skips / auto-disable (the cron policy) ─────────────────────────────

  private recordSkip(l: Listener, reason: string): void {
    l.consecutiveSkips++
    const label = l.name ?? `${l.on} → ${l.action.type}`
    if (l.consecutiveSkips === SKIPS_BEFORE_WARN) {
      this.ctx.notify({ type: 'agent', id: `listener:${l.id}`, title: `Listener ${l.id} skipping (${l.consecutiveSkips}×)`, body: `${label} — ${reason}. Auto-disables after ${MAX_SKIPS_BEFORE_DISABLE}.`, pane: 'agents' })
    }
    if (l.consecutiveSkips >= MAX_SKIPS_BEFORE_DISABLE) {
      l.disabledAt = this.now()
      this.disarm(l.id)
      this.ctx.notify({ type: 'agent', id: `listener:${l.id}`, title: `Listener ${l.id} auto-disabled`, body: `${label} disabled after ${l.consecutiveSkips} skips (${reason}). \`con listen resume ${l.id}\` re-enables.`, pane: 'agents' })
      this.ctx.log(`[listeners] auto-disabled ${l.id} after ${l.consecutiveSkips} skips (${reason})`)
    }
  }

  private notifyOwnerOfRemoval(l: Listener, actor: string): void {
    const session = findByClaudeSessionId(this.ctx.getSessions().values(), l.owner.claudeSessionId)
    if (!session || session.status === 'ended') return
    if (session.agentKey === actor || session.id === actor || session.claudeSessionId === actor) return
    try {
      wakeOrQueue(session, `[HUB LISTENER REMOVED]\nYour listener \`${l.id}\` (on \`${l.on}\`${l.where.length ? ` where ${l.where.map(formatWhere).join(' && ')}` : ''} → ${describeAction(l.action)}) was removed by **${actor}**. Verify you still need it and re-register with \`con listen add\` if so.`, this.ctx.broadcast)
    } catch (e) {
      this.ctx.log(`[listeners] owner notice failed: ${(e as Error).message}`)
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────

  /** Dry run: which rung would stop this event? Runs the guard (read-only by contract), never the action. */
  async test(id: string, ev: HubEvent): Promise<TestResult> {
    const l = this.store.get(id)
    if (!l) throw new Error('listener not found')
    if (!topicMatches(l.on, ev.topic)) return { stage: 'no-match', detail: `topic ${ev.topic} does not match ${l.on}` }
    const failing = l.where.find((c) => !whereMatches(ev, [c]))
    if (failing) return { stage: 'where', detail: `${formatWhere(failing)} is false (value: ${JSON.stringify(pathGet(ev, failing.path))})` }
    const now = this.now()
    if (!inWindow(now, l.hours, l.days)) return { stage: 'window', detail: `outside ${[l.days, l.hours].filter(Boolean).join(' ')} — would ${l.dropOutside ? 'drop' : `hold until ${fmtWhen(nextWindowStart(now, l.hours, l.days) ?? now)}`}` }
    if (l.pausedAt) return { stage: 'paused', detail: l.pauseReason ?? 'paused' }
    if (l.cooldownMs && l.stats.lastFiredAt && now < l.stats.lastFiredAt + l.cooldownMs) return { stage: 'cooldown', detail: `would hold until ${fmtWhen(l.stats.lastFiredAt + l.cooldownMs)}` }
    let guardOutput: string | undefined
    if (l.guard) {
      const g = await this.runGuard(l, [ev])
      if (g.error) return { stage: 'guard', detail: `guard error: ${g.error}` }
      if (!g.proceed) return { stage: 'guard', detail: `guard exited non-zero${g.output ? `: ${g.output.slice(0, 200)}` : ''}` }
      guardOutput = g.output
    }
    return { stage: 'would-fire', detail: describeAction(l.action), ...(l.action.type === 'wake' ? { envelope: buildEventEnvelope(l, [ev], guardOutput) } : {}) }
  }

  /** Run one listener against an archived event for real, bypassing coalesce/cooldown/window/pause. */
  async redeliver(eventId: string, listenerId: string): Promise<{ ok: boolean; detail: string }> {
    const l = this.store.get(listenerId)
    if (!l) return { ok: false, detail: 'listener not found' }
    if (!this.ctx.bus.get(eventId)) return { ok: false, detail: 'event not found' }
    const o = await this.runBatch(l, [eventId], 'redeliver')
    return { ok: o.stage === 'fired', detail: o.detail ?? o.stage }
  }
}

function shellEnv(l: Listener, events: HubEvent[]): Record<string, string> {
  const first = events[0]!
  return {
    LISTENER_ID: l.id,
    EVENT_TOPIC: first.topic,
    EVENT_ID: first.id,
    EVENT_IDS: events.map((e) => e.id).join(','),
    EVENT_COUNT: String(events.length),
  }
}


export function validateAction(a: ListenerAction | undefined): ListenerAction {
  if (!a || typeof a !== 'object' || !('type' in a)) throw new Error('an action is required: --wake | --run | --post | --notify | --emit | --card')
  switch (a.type) {
    case 'wake': {
      if (!a.prompt?.trim()) throw new Error('--wake needs a prompt')
      if (a.model && !a.fork) throw new Error('--model only applies to --fork wakes (the target session keeps its own model)')
      if (a.model && !/^[a-z0-9][\w.:-]*$/i.test(a.model)) throw new Error(`--model wants an alias (haiku, sonnet, opus, fable) or a model id, got "${a.model}"`)
      return { type: 'wake', prompt: a.prompt.trim(), ...(a.as ? { as: a.as } : {}), ...(a.fork ? { fork: true } : {}), ...(a.model ? { model: a.model } : {}) }
    }
    case 'run': if (!a.cmd?.trim()) throw new Error('--run needs a command'); return { type: 'run', cmd: a.cmd.trim() }
    case 'post': {
      if (!/^https?:\/\//.test(a.url ?? '')) throw new Error('--post needs an http(s) URL')
      return { type: 'post', url: a.url, ...(a.method ? { method: a.method.toUpperCase() } : {}), ...(a.headers && Object.keys(a.headers).length ? { headers: a.headers } : {}) }
    }
    case 'notify': if (!a.title?.trim()) throw new Error('--notify needs a title'); return { type: 'notify', title: a.title.trim(), ...(a.body ? { body: a.body } : {}) }
    case 'emit': {
      if (!a.topic || !/^[a-z][a-z0-9]*(\.[a-z0-9_-]+)+$/.test(a.topic)) throw new Error('--emit needs a dotted topic, e.g. home.arrived')
      return { type: 'emit', topic: a.topic, ...(a.data ? { data: a.data } : {}) }
    }
    case 'card': {
      if (!a.project?.trim() || !a.text?.trim()) throw new Error('--card needs a project and text')
      return { type: 'card', project: a.project.trim(), text: a.text.trim(), ...(a.column ? { column: a.column } : {}), ...(a.assign ? { assign: a.assign } : {}) }
    }
    default: throw new Error(`unknown action type ${(a as { type: string }).type}`)
  }
}
