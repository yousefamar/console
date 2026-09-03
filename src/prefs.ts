// User preferences — hub-backed cross-device sync.
//
// The hub owns the canonical prefs blob (~/.config/console/prefs.json).
// `initPrefs()` fetches it once on boot; readers use `getPref(key, default)`
// which is synchronous after init. Writes update the in-memory cache
// immediately so the UI is snappy, then PUT to the hub in the background.
// If the hub is offline writes stay in memory — acceptable for prefs since
// the next write attempt will send the full current key.
//
// This replaces scattered `localStorage.getItem('console_dnd')` etc. for
// user-controlled state that should follow the user across devices.
// localStorage is still appropriate for device-specific things like the
// hub URL override or one-shot "have we prompted?" flags.

import { hubFetch } from '@/hub'

export type PrefValue = string | number | boolean | null | PrefValue[] | { [k: string]: PrefValue }

let cache: Record<string, PrefValue> = {}
let loaded = false
/** Keys written locally since boot — they win over a later (re)load's copy. */
const localWrites = new Set<string>()
const listeners = new Map<string, Set<(value: PrefValue | undefined) => void>>()
let markReady: () => void
let readyPromise = new Promise<void>((resolve) => { markReady = resolve })
let initInFlight: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Backoff for a failed load. Capped — the hub usually comes back in seconds. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

/**
 * Load the hub's prefs blob. Resolves only once a load SUCCEEDS; a failure
 * schedules a retry and leaves `isPrefsLoaded()` false.
 *
 * That distinction is load-bearing: this used to `catch → cache = {}` and set
 * `loaded = true` anyway, so a single timed-out `/config` (a busy or restarting
 * hub — 4 s is easy to blow past) left every reader seeing DEFAULTS while every
 * `isPrefsLoaded()` guard reported "safe to persist". The next automatic write
 * then pushed those defaults over the real values, which is how a curated
 * calendar-visibility set became two entries (2026-09-03: `/config` GET aborted
 * at 4000 ms, and 42 s later an overlay register wrote its 2-element set over
 * the hub's 9). "Settings keep resetting, and then the WRONG ones persist" is
 * the signature of this class, for any pref — not just calendars.
 */
export async function initPrefs(): Promise<void> {
  if (initInFlight) return initInFlight
  initInFlight = attemptLoad()
  return initInFlight
}

async function attemptLoad(attempt = 0): Promise<void> {
  try {
    const fresh = await hubFetch<Record<string, PrefValue>>('/config', { timeoutMs: 4000 })
    // A retry can land after the user has already changed something; their
    // newer value must not be reverted by the hub copy we asked for earlier.
    for (const [k, v] of Object.entries(fresh)) {
      if (!localWrites.has(k)) cache[k] = v
    }
    loaded = true
    markReady()
  } catch {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!
    // Never resolve on failure: consumers that gate on prefs must keep waiting
    // (they race their own timeout), and nothing may persist a default.
    await new Promise<void>((resolve) => {
      retryTimer = setTimeout(resolve, delay)
    })
    return attemptLoad(attempt + 1)
  }
}

export function isPrefsLoaded(): boolean {
  return loaded
}

/**
 * Resolves once the hub's prefs have actually been LOADED (never on failure —
 * see `initPrefs`). Callers should race a timeout so an unreachable hub can't
 * hang them; on that path they must not write anything back.
 */
export function prefsReady(): Promise<void> {
  return readyPromise
}

/** Test seam: forget the cache + retry state. */
export function __resetPrefsForTests(): void {
  cache = {}
  loaded = false
  localWrites.clear()
  listeners.clear()
  initInFlight = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  readyPromise = new Promise<void>((resolve) => { markReady = resolve })
}

export function getPref<T extends PrefValue>(key: string, fallback: T): T {
  const value = cache[key]
  return (value === undefined ? fallback : value) as T
}

export function setPref<T extends PrefValue>(key: string, value: T): void {
  cache[key] = value
  localWrites.add(key)
  const subs = listeners.get(key)
  if (subs) for (const fn of subs) fn(value)
  // Fire-and-forget; pref writes aren't critical-path and the hub merge is
  // idempotent — a failed request just means the next successful one wins.
  hubFetch('/config', {
    method: 'PUT',
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {})
}

export function onPrefChange<T extends PrefValue>(
  key: string,
  fn: (value: T | undefined) => void,
): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(fn as (value: PrefValue | undefined) => void)
  return () => {
    set?.delete(fn as (value: PrefValue | undefined) => void)
  }
}
