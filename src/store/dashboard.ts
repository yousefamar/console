// Dashboard state — server snapshot, alerts, canvas reload counter.
//
// Polling cadence: snapshot every 30s, alerts every 15s. Canvas live-reloads
// off a SyncBus event (no polling) — the store just bumps `canvasReloadKey`
// which the iframe component uses as its `src` cache-buster.

import { create } from 'zustand'
import { hubFetch } from '@/hub'
import { hubBus } from '@/sync-bus'

export interface ExternalServer {
  id: string
  name: string
  url: string
  expectStatus?: number
}

export interface ProbeOk { ok: true; latencyMs?: number; status?: number }
export interface ProbeErr { ok: false; error: string; status?: number; latencyMs?: number }
export type ProbeResult = ProbeOk | ProbeErr

export interface TailscaleHost {
  hostname: string
  dnsName: string
  os?: string
  online: boolean
  self: boolean
}

export interface Pm2Process {
  name: string
  pid?: number
  status: string
  uptimeMs: number
  restartCount: number
  memoryBytes: number
  cpuPct: number
}

export interface DashboardSnapshot {
  generatedAt: number
  hub: { ok: true; uptimeMs: number; sessions: number }
  tailscale: TailscaleHost[]
  pm2: Pm2Process[]
  external: Array<ExternalServer & { probe: ProbeResult }>
}

export type DashboardAlert =
  | { kind: 'agent-approval'; sessionId: string; sessionName?: string; requestId: string; toolName: string; question?: string; ts: number }
  | { kind: 'cal-upcoming'; summary: string; startMs: number; calendarId: string }
  | { kind: 'error'; ts: number; source: string; message: string }

export interface CanvasMeta {
  updatedAt: number
  sizeBytes: number
  isPlaceholder: boolean
}

interface DashboardState {
  snapshot: DashboardSnapshot | null
  snapshotLoading: boolean
  snapshotError: string | null
  alerts: DashboardAlert[]
  alertsLoading: boolean
  canvasReloadKey: number
  canvasMeta: CanvasMeta | null

  refreshSnapshot: () => Promise<void>
  refreshAlerts: () => Promise<void>
  refreshCanvasMeta: () => Promise<void>
  clearCanvas: () => Promise<void>
  addServer: (name: string, url: string) => Promise<void>
  removeServer: (id: string) => Promise<void>
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  snapshot: null,
  snapshotLoading: false,
  snapshotError: null,
  alerts: [],
  alertsLoading: false,
  canvasReloadKey: 0,
  canvasMeta: null,

  refreshSnapshot: async () => {
    set({ snapshotLoading: true, snapshotError: null })
    try {
      const snap = await hubFetch<DashboardSnapshot>('/dashboard/snapshot', { timeoutMs: 8000 })
      set({ snapshot: snap, snapshotLoading: false })
    } catch (err) {
      set({ snapshotLoading: false, snapshotError: (err as Error).message })
    }
  },

  refreshAlerts: async () => {
    set({ alertsLoading: true })
    try {
      const r = await hubFetch<{ alerts: DashboardAlert[] }>('/dashboard/alerts', { timeoutMs: 5000 })
      set({ alerts: r.alerts, alertsLoading: false })
    } catch {
      set({ alertsLoading: false })
    }
  },

  refreshCanvasMeta: async () => {
    try {
      const meta = await hubFetch<CanvasMeta>('/canvas/_meta', { timeoutMs: 3000 })
      set({ canvasMeta: meta })
    } catch { /* ignore */ }
  },

  clearCanvas: async () => {
    await hubFetch('/canvas', { method: 'DELETE', timeoutMs: 3000 })
    set((s) => ({ canvasReloadKey: s.canvasReloadKey + 1 }))
    await get().refreshCanvasMeta()
  },

  addServer: async (name, url) => {
    await hubFetch('/dashboard/servers', {
      method: 'POST',
      body: JSON.stringify({ name, url }),
      timeoutMs: 3000,
    })
    await get().refreshSnapshot()
  },

  removeServer: async (id) => {
    await hubFetch(`/dashboard/servers/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 3000 })
    await get().refreshSnapshot()
  },
}))

// ---- WS subscription: bump canvasReloadKey when the dir changes ----

let wired = false
export function wireDashboardBus(): void {
  if (wired) return
  wired = true
  hubBus.on('dashboard', 'canvas_changed', (data) => {
    const meta = data as CanvasMeta
    useDashboardStore.setState((s) => ({
      canvasReloadKey: s.canvasReloadKey + 1,
      canvasMeta: meta,
    }))
  })
}
