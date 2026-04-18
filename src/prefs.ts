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
// hub URL override, notes tab state, or one-shot "have we prompted?" flags.

import { hubFetch } from '@/hub'

export type PrefValue = string | number | boolean | null | PrefValue[] | { [k: string]: PrefValue }

let cache: Record<string, PrefValue> = {}
let loaded = false
const listeners = new Map<string, Set<(value: PrefValue | undefined) => void>>()

export async function initPrefs(): Promise<void> {
  try {
    cache = await hubFetch<Record<string, PrefValue>>('/config')
  } catch {
    // Hub unavailable — start empty; callers get their defaults until the hub
    // becomes reachable on a later setPref() (which will push cache up).
    cache = {}
  }
  loaded = true
}

export function isPrefsLoaded(): boolean {
  return loaded
}

export function getPref<T extends PrefValue>(key: string, fallback: T): T {
  const value = cache[key]
  return (value === undefined ? fallback : value) as T
}

export function setPref<T extends PrefValue>(key: string, value: T): void {
  cache[key] = value
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
