// Cron store — mirrors the hub-side scheduler.
//
// Polls /cron on demand (when a session view is open). Mutations re-fetch
// optimistically. No WebSocket sync in v1; polling cycle is short enough.

import { create } from 'zustand'
import { hubFetch, getHubUrl } from '@/hub'

export interface HubCronTask {
  id: string
  claudeSessionId: string
  trigger: string
  recurring: boolean
  prompt: string
  /** Optional shell guard — the agent wakes only when it exits 0 (token-free
   *  polling). See server/src/cron/scheduler.ts. */
  guard?: string
  createdAt: number
  lastFiredAt?: number
  lastCheckedAt?: number
  lastGuardResult?: 'fired' | 'skipped' | 'error'
  lastSkipReason?: string
  consecutiveSkips: number
  disabledAt?: number
}

interface CronState {
  tasksBySession: Record<string, HubCronTask[]>
  loadingBySession: Record<string, boolean>
  errorBySession: Record<string, string | undefined>
  icsToken: string | null
  /** Set when the hub detects a Tailscale Funnel path mapping for /cron.ics —
   *  the GCal-ready URL. Null means tailnet-only (use local URL). */
  icsPublicUrl: string | null

  refresh: (claudeSessionId: string) => Promise<void>
  refreshAll: () => Promise<void>
  add: (input: { claudeSessionId: string; trigger: string; prompt: string; recurring: boolean }) => Promise<HubCronTask>
  remove: (id: string) => Promise<void>
  runOnce: (id: string) => Promise<{ ok: boolean; reason?: string }>
  fetchIcsToken: () => Promise<string>
  /** Returns the best ICS URL available — public funnel URL if set, else local. */
  icsUrl: () => string | null
}

export const useCronStore = create<CronState>((set, get) => ({
  tasksBySession: {},
  loadingBySession: {},
  errorBySession: {},
  icsToken: null,
  icsPublicUrl: null,

  refresh: async (claudeSessionId) => {
    set((s) => ({ loadingBySession: { ...s.loadingBySession, [claudeSessionId]: true } }))
    try {
      const tasks = await hubFetch<HubCronTask[]>(`/cron?session=${encodeURIComponent(claudeSessionId)}`)
      set((s) => ({
        tasksBySession: { ...s.tasksBySession, [claudeSessionId]: tasks },
        errorBySession: { ...s.errorBySession, [claudeSessionId]: undefined },
      }))
    } catch (e) {
      set((s) => ({ errorBySession: { ...s.errorBySession, [claudeSessionId]: (e as Error).message } }))
    } finally {
      set((s) => ({ loadingBySession: { ...s.loadingBySession, [claudeSessionId]: false } }))
    }
  },

  refreshAll: async () => {
    try {
      const tasks = await hubFetch<HubCronTask[]>('/cron')
      const grouped: Record<string, HubCronTask[]> = {}
      for (const t of tasks) {
        const arr = grouped[t.claudeSessionId] ?? []
        arr.push(t)
        grouped[t.claudeSessionId] = arr
      }
      set({ tasksBySession: grouped })
    } catch { /* best effort */ }
  },

  add: async (input) => {
    const task = await hubFetch<HubCronTask>('/cron', { method: 'POST', body: JSON.stringify(input) })
    await get().refresh(input.claudeSessionId)
    return task
  },

  remove: async (id) => {
    // Find which session owns this task to know what to refresh
    let owner: string | undefined
    for (const [csid, list] of Object.entries(get().tasksBySession)) {
      if (list.some((t) => t.id === id)) { owner = csid; break }
    }
    await hubFetch<{ removed: boolean }>(`/cron/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (owner) await get().refresh(owner)
  },

  runOnce: async (id) => {
    return hubFetch<{ ok: boolean; reason?: string }>(`/cron/${encodeURIComponent(id)}/run`, { method: 'POST' })
  },

  fetchIcsToken: async () => {
    const r = await hubFetch<{ token: string; publicUrl: string | null }>('/cron/ics-token')
    set({ icsToken: r.token, icsPublicUrl: r.publicUrl })
    return r.token
  },

  icsUrl: () => {
    const { icsPublicUrl, icsToken } = get()
    if (icsPublicUrl) return icsPublicUrl
    if (!icsToken) return null
    return `${getHubUrl()}/cron.ics?token=${icsToken}`
  },
}))
