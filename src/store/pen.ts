// Pen (Neo smartpen) store — mirrors the hub's PenSnapshot and exposes control
// actions. Unlike glasses (driven through the native ConsoleNative bridge), the
// pen is driven entirely through the hub's `/pen/*` HTTP routes (the hub RPCs
// the phone, which owns the BLE link). So this store just talks to the hub.

import { create } from 'zustand'
import { hubFetch, HubError } from '@/hub'

export type PenStatus = 'disconnected' | 'connecting' | 'connected'

export interface PenSnapshot {
  status: PenStatus
  mac: string | null
  name: string | null
  firmware: string | null
  battery: number | null
  usedMemPct: number | null
  locked: boolean
  authorized: boolean
  offlineSaveOn: boolean | null
  lastError: string | null
  lastDotX: number | null
  lastDotY: number | null
  lastUpdatedMs: number
}

export interface PenScanObservation {
  name: string
  mac: string
  rssi: number
  ts: number
}

interface PenStore {
  snapshot: PenSnapshot | null
  /** True when the APK isn't reachable on /push (the hub answered 503). */
  apkOffline: boolean
  scanning: boolean
  observations: PenScanObservation[]
  /** Opt-in: live-stream pen pages into the Notes tab (hub-side toggle). */
  streaming: boolean

  refresh: () => Promise<void>
  refreshObservations: () => Promise<void>
  refreshStream: () => Promise<void>
  setStreaming: (enabled: boolean) => Promise<void>
  scan: (durationMs?: number) => Promise<void>
  /** No mac → reconnect the saved pen; with mac → connect that specific device. */
  connect: (mac?: string) => Promise<void>
  disconnect: () => Promise<void>
  unlock: (password: string) => Promise<void>
}

/** Body shape the hub returns alongside a 503 when the APK isn't connected. */
interface PenStatus503 {
  error?: string
  cached?: PenSnapshot | null
  cachedAgeMs?: number
}

export const usePenStore = create<PenStore>((set, get) => ({
  snapshot: null,
  apkOffline: false,
  scanning: false,
  observations: [],
  streaming: false,

  refresh: async () => {
    try {
      const snap = await hubFetch<PenSnapshot>('/pen/status')
      set({ snapshot: snap, apkOffline: false })
    } catch (e) {
      // The APK not being connected returns a 503 carrying the last cached
      // snapshot — surface it (greyed out) rather than wiping the UI.
      if (e instanceof HubError && e.status === 503) {
        let cached: PenSnapshot | null = null
        try {
          const body = JSON.parse(e.message) as PenStatus503
          cached = body.cached ?? null
        } catch { /* non-JSON body */ }
        set({ snapshot: cached, apkOffline: true })
        return
      }
      // Other errors: leave the previous snapshot in place.
    }
  },

  refreshObservations: async () => {
    try {
      const obs = await hubFetch<PenScanObservation[]>('/pen/scan/observations')
      set({ observations: Array.isArray(obs) ? obs : [] })
    } catch {
      // leave previous
    }
  },

  refreshStream: async () => {
    try {
      const r = await hubFetch<{ streaming: boolean }>('/pen/stream')
      set({ streaming: r.streaming === true })
    } catch {
      // leave previous
    }
  },

  setStreaming: async (enabled) => {
    set({ streaming: enabled }) // optimistic
    try {
      const r = await hubFetch<{ streaming: boolean }>('/pen/stream', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      set({ streaming: r.streaming === true })
    } catch {
      void get().refreshStream() // revert to hub truth
    }
  },

  scan: async (durationMs = 15_000) => {
    set({ scanning: true, observations: [] })
    try {
      await hubFetch('/pen/scan', { method: 'POST', body: JSON.stringify({ durationMs }) })
    } catch {
      set({ scanning: false })
      return
    }
    // Poll observations while the scan runs, then settle.
    const interval = window.setInterval(() => { void get().refreshObservations() }, 2_000)
    window.setTimeout(() => {
      window.clearInterval(interval)
      void get().refreshObservations()
      set({ scanning: false })
    }, durationMs + 500)
  },

  connect: async (mac) => {
    try {
      // No mac → reconnect the pen the phone already saved (no scan needed).
      const body = mac ? JSON.stringify({ mac }) : '{}'
      await hubFetch('/pen/connect', { method: 'POST', body })
    } catch { /* surfaced via lastError on next refresh */ }
    await get().refresh()
  },

  disconnect: async () => {
    try {
      await hubFetch('/pen/disconnect', { method: 'POST' })
    } catch { /* ignore */ }
    await get().refresh()
  },

  unlock: async (password) => {
    try {
      await hubFetch('/pen/unlock', { method: 'POST', body: JSON.stringify({ password }) })
    } catch { /* surfaced via lastError on next refresh */ }
    await get().refresh()
  },
}))
