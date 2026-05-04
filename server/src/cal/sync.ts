// ============================================================================
// Calendar sync loop — runs on the hub.
//
// Polls each visible calendar for the user's Google accounts every few
// minutes. Detects new/changed/removed events by diffing the last-seen event
// set per calendar. Broadcasts deltas so the browser can reconcile its Dexie
// cache. Fires push notifications for per-event reminders.
//
// Reminder firing is driven by a separate 30s ticker. Each sync pass caches
// the minimum reminder data per upcoming event (start time, summary, override
// minutes) into `upcoming`; the ticker scans that in-memory map, compares
// `now` against `start - overrideMinutes` windows, and fires once per event.
//
// State persisted to ~/.config/console/cal-state.json. `fired` survives hub
// restarts so we don't re-fire the same reminder on every boot; `upcoming`
// does not — it's rebuilt from the next sync pass.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CalendarClient } from '../calendar-client.js'
import type { SyncBus } from '../sync-bus.js'
import type { PushServer } from '../push.js'
import type { AuthStore } from '../auth-store.js'

type EventFingerprint = string // hash of `updated` timestamp + status

/** Minimum data needed to fire a push notification for an event reminder. */
type ReminderEntry = {
  calendarId: string
  summary: string
  startMs: number
  /** Override minutes-before-start. Empty array = no per-event reminders configured. */
  minutesBefore: number[]
}

type CalendarState = {
  /** calendarId -> (eventId -> fingerprint) */
  events: Record<string, Record<string, EventFingerprint>>
  /** Fired reminders (reminderKey -> timestamp) to avoid double-firing. */
  fired: Record<string, number>
}
type CalState = Record<string /* account email */, CalendarState>

export type CalDelta = {
  account: string
  calendarId: string
  added: any[]
  updated: any[]
  removed: string[]
}

function fpOf(ev: any): EventFingerprint {
  return `${ev.updated ?? ''}|${ev.status ?? ''}`
}

export class CalendarSync {
  private state: CalState = {}
  private timer: ReturnType<typeof setInterval> | null = null
  private reminderTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly INTERVAL_MS = 120_000 // 2 min
  private readonly REMINDER_TICK_MS = 30_000 // scan upcoming every 30s
  /**
   * Slack window for reminder firing. A reminder is "due" when
   *   now ∈ [start - minutesBefore*60s − slack, start - minutesBefore*60s + slack]
   * — 60s gives us resilience against a tick being a few seconds late without
   * double-firing (deduped by the `fired` map anyway).
   */
  private readonly REMINDER_SLACK_MS = 60_000

  /**
   * In-memory map of upcoming events with their reminder minutes, keyed by
   * account+event. Rebuilt from each sync pass. Not persisted — if the hub
   * restarts we miss any reminders during the downtime, which is acceptable.
   */
  private upcoming = new Map<string, ReminderEntry>()

  /**
   * Broader cache of all upcoming events (regardless of reminder config) so
   * the dashboard can show "next event in N min". Keyed by account+event.
   * Rebuilt from each sync pass; entries past their start are pruned by
   * `getUpcomingWithin`.
   */
  private upcomingAll = new Map<string, { calendarId: string; summary: string; startMs: number }>()

  constructor(
    private readonly cal: CalendarClient,
    private readonly auth: AuthStore,
    private readonly bus: SyncBus,
    private readonly push: PushServer,
    private readonly stateFile: string,
    private readonly log: (msg: string) => void,
  ) {
    this.loadState()
  }

  start(): void {
    if (this.timer) return
    this.log('[cal-sync] starting')
    setTimeout(() => { this.tick().catch((e) => this.log(`[cal-sync] initial tick failed: ${e}`)) }, 8_000)
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log(`[cal-sync] tick failed: ${e}`))
    }, this.INTERVAL_MS)
    // Reminder ticker runs independently so a 5-min override actually fires
    // close to on time regardless of the sync cadence.
    this.reminderTimer = setInterval(() => {
      try { this.checkReminders() } catch (e) { this.log(`[cal-sync] reminder check failed: ${e}`) }
    }, this.REMINDER_TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    this.reminderTimer = null
  }

  async syncNow(): Promise<{ ok: true }> {
    await this.tick()
    return { ok: true }
  }

  /**
   * Events starting within `windowMs` from now (or already started within
   * the last minute, so a meeting that just kicked off still appears).
   * Sorted by start time ascending. Used by the dashboard alerts tile.
   */
  getUpcomingWithin(windowMs: number): Array<{ calendarId: string; summary: string; startMs: number }> {
    const now = Date.now()
    const upper = now + windowMs
    const out: Array<{ calendarId: string; summary: string; startMs: number }> = []
    for (const [key, entry] of this.upcomingAll) {
      if (entry.startMs < now - 60_000) { this.upcomingAll.delete(key); continue }
      if (entry.startMs <= upper) out.push(entry)
    }
    return out.sort((a, b) => a.startMs - b.startMs)
  }

  // ---- internals ----

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const account of this.auth.getGoogleAccounts().map((a) => a.email)) {
        try { await this.syncAccount(account) }
        catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.log(`[cal-sync] ${account} failed: ${msg}`)
          this.bus.broadcast('cal', 'error', { account, message: msg })
        }
      }
      this.checkReminders()
    } finally {
      this.running = false
    }
  }

  private async syncAccount(account: string): Promise<void> {
    const list = await this.cal.getCalendarList(account).catch(() => null)
    if (!list) return
    const visible = list.items.filter((c) => c.selected !== false)

    const now = new Date()
    const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const timeMax = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString()

    if (!this.state[account]) this.state[account] = { events: {}, fired: {} }
    const accState = this.state[account]

    for (const cal of visible) {
      const resp = await this.cal.getEvents(account, cal.id, { timeMin, timeMax }).catch(() => null) as any
      if (!resp) continue
      const events: any[] = resp.items ?? []
      const prevFps = accState.events[cal.id] ?? {}
      const nextFps: Record<string, EventFingerprint> = {}
      const added: any[] = []
      const updated: any[] = []
      for (const ev of events) {
        const id = ev.id as string
        if (!id) continue
        const fp = fpOf(ev)
        nextFps[id] = fp
        if (!(id in prevFps)) added.push(ev)
        else if (prevFps[id] !== fp) updated.push(ev)
        // Cache reminder info for events within the next 25h. Anything further
        // out will be picked up by the next sync that brings the start time
        // inside the window.
        this.cacheReminder(account, cal.id, ev)
      }
      const removed: string[] = []
      for (const id of Object.keys(prevFps)) {
        if (!(id in nextFps)) removed.push(id)
      }
      accState.events[cal.id] = nextFps
      // Drop removed events from the upcoming cache so we don't fire for
      // cancelled items.
      for (const rid of removed) {
        this.upcoming.delete(`${account}:${rid}`)
        this.upcomingAll.delete(`${account}:${rid}`)
      }

      if (added.length + updated.length + removed.length > 0) {
        const delta: CalDelta = { account, calendarId: cal.id, added, updated, removed }
        this.bus.broadcast('cal', 'delta', delta)
      }
    }

    this.saveState()
  }

  /** Record an event's reminder hints in the in-memory `upcoming` cache. */
  private cacheReminder(account: string, calendarId: string, ev: any): void {
    const key = `${account}:${ev.id}`
    if (ev.status === 'cancelled') {
      this.upcoming.delete(key)
      this.upcomingAll.delete(key)
      return
    }

    const startIso: string | undefined = ev.start?.dateTime ?? ev.start?.date
    if (!startIso) return
    const startMs = new Date(startIso).getTime()
    if (!Number.isFinite(startMs)) return

    // Cache for the dashboard's broader "next event" view — independent of
    // whether the event has reminder overrides. Same 25h window.
    const now = Date.now()
    if (startMs < now - 60_000 || startMs - now > 25 * 60 * 60 * 1000) {
      this.upcoming.delete(key)
      this.upcomingAll.delete(key)
      return
    }
    this.upcomingAll.set(key, { calendarId, summary: ev.summary || '(No title)', startMs })

    // Pull override minutes. If `useDefault` is true Google uses the calendar
    // default which we don't mirror here — skip (matches v1 scope). Otherwise
    // use the explicit overrides.
    const reminders = ev.reminders ?? {}
    const overrides: Array<{ minutes?: number; method?: string }> = reminders.overrides ?? []
    const minutesBefore = overrides
      .filter((o) => typeof o.minutes === 'number' && o.minutes >= 0)
      .map((o) => o.minutes as number)

    if (minutesBefore.length === 0) { this.upcoming.delete(key); return }

    this.upcoming.set(key, {
      calendarId,
      summary: ev.summary || '(No title)',
      startMs,
      minutesBefore,
    })
  }

  /**
   * Fire push notifications for events whose reminder time is now-ish.
   *
   * A reminder fires when `now` is within ±REMINDER_SLACK_MS of
   * `start - minutesBefore*60s`. Each (eventId, minutesBefore) pair fires at
   * most once — tracked in the persisted `fired` map so restarts don't
   * re-fire. We also skip firing if the target time is already more than
   * SLACK in the past (missed-window case after a long hub downtime).
   */
  private checkReminders(): void {
    const now = Date.now()
    let fired = 0
    for (const [key, entry] of this.upcoming.entries()) {
      const colon = key.indexOf(':')
      const account = key.slice(0, colon)
      const eventId = key.slice(colon + 1)

      const accState = this.state[account]
      if (!accState) continue

      // Skip if the event has already passed well beyond its start — clean up
      // the cache entry while we're here.
      if (entry.startMs + 60_000 < now) {
        this.upcoming.delete(key)
        continue
      }

      for (const minutes of entry.minutesBefore) {
        const fireAt = entry.startMs - minutes * 60_000
        const delta = now - fireAt
        // Window: fire if now is within slack of the target; skip if we're
        // still too early, and skip if we missed the window entirely.
        if (delta < -this.REMINDER_SLACK_MS) continue
        if (delta > this.REMINDER_SLACK_MS) continue

        const fireKey = `${eventId}:${minutes}`
        if (accState.fired[fireKey]) continue
        accState.fired[fireKey] = now
        fired++

        const whenMsg = minutes === 0
          ? 'starting now'
          : minutes < 60
            ? `in ${minutes} min`
            : minutes % 60 === 0
              ? `in ${minutes / 60}h`
              : `in ${Math.round(minutes / 60)}h`

        this.push.broadcast({
          type: 'calendar',
          title: entry.summary,
          body: `${whenMsg} — ${account}`,
          pane: 'calendar',
          id: `cal:${account}:${fireKey}`,
        })
      }
    }

    // Prune fired entries older than 1 day to keep the persisted state small.
    for (const accState of Object.values(this.state)) {
      for (const [id, ts] of Object.entries(accState.fired)) {
        if (now - ts > 24 * 60 * 60 * 1000) delete accState.fired[id]
      }
    }

    if (fired > 0) this.saveState()
  }

  private loadState(): void {
    try {
      if (existsSync(this.stateFile)) {
        this.state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as CalState
      }
    } catch (e) {
      this.log(`[cal-sync] failed to load state: ${e}`)
      this.state = {}
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch (e) {
      this.log(`[cal-sync] failed to save state: ${e}`)
    }
  }
}
