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

// ---- Bedrock cost analytics (AWS Cost Explorer, see server/src/aws-costs.ts) ----

export interface CostDay {
  date: string
  byOwner: Record<string, number>
  byModel: Record<string, number>
  usd: number
}

export interface CostReport {
  generatedAt: number
  start: string
  end: string
  days: CostDay[]
  /** Owners ranked by spend, `untagged` last. Chart stacking order. */
  owners: string[]
  models: string[]
  totalUsd: number
  /** Mean over COMPLETE days only — today's bucket is partial. */
  avgPerDayUsd: number
  avgDayCount: number
  todayUsd: number
  totalByOwner: Record<string, number>
  totalByModel: Record<string, number>
  empty: boolean
  /** First date per-user attribution is possible; earlier days are all-untagged
   *  by construction (cost-allocation tags don't backfill). */
  ownerTagEpoch: string
}

export type CostStackBy = 'owner' | 'model'

interface DashboardState {
  snapshot: DashboardSnapshot | null
  snapshotLoading: boolean
  snapshotError: string | null
  alerts: DashboardAlert[]
  alertsLoading: boolean
  canvasReloadKey: number
  canvasMeta: CanvasMeta | null
  costs: CostReport | null
  costsLoading: boolean
  costsError: string | null
  costDays: number
  /** Which dimension the chart stacks. `model` is the informative cut while most
   *  fleet spend is untagged. */
  costStackBy: CostStackBy

  refreshSnapshot: () => Promise<void>
  refreshAlerts: () => Promise<void>
  refreshCanvasMeta: () => Promise<void>
  clearCanvas: () => Promise<void>
  addServer: (name: string, url: string) => Promise<void>
  removeServer: (id: string) => Promise<void>
  /** `refresh` forces a fresh Cost Explorer call (~$0.01); otherwise the hub
   *  serves its TTL cache. */
  refreshCosts: (opts?: { refresh?: boolean }) => Promise<void>
  setCostDays: (days: number) => void
  setCostStackBy: (by: CostStackBy) => void
}

// NB: these must be declared ABOVE the store — `create()` runs its initializer
// eagerly at module scope, so a `const` below it is still in its TDZ when
// loadCostDays() reads it (which throws and blanks the entire app, not just this
// card).
const COST_DAYS_KEY = 'console:home:costDays'
const COST_STACK_KEY = 'console:home:costStackBy'
const COST_DAY_OPTIONS = [7, 30, 90] as const

function loadCostDays(): number {
  if (typeof localStorage === 'undefined') return 30
  const n = Number(localStorage.getItem(COST_DAYS_KEY))
  return (COST_DAY_OPTIONS as readonly number[]).includes(n) ? n : 30
}

function loadCostStackBy(): CostStackBy {
  if (typeof localStorage === 'undefined') return 'owner'
  return localStorage.getItem(COST_STACK_KEY) === 'model' ? 'model' : 'owner'
}

export { COST_DAY_OPTIONS }

export const useDashboardStore = create<DashboardState>((set, get) => ({
  snapshot: null,
  snapshotLoading: false,
  snapshotError: null,
  alerts: [],
  alertsLoading: false,
  canvasReloadKey: 0,
  canvasMeta: null,
  costs: null,
  costsLoading: false,
  costsError: null,
  costDays: loadCostDays(),
  costStackBy: loadCostStackBy(),

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

  refreshCosts: async (opts = {}) => {
    const days = get().costDays
    set({ costsLoading: true, costsError: null })
    try {
      // Generous timeout: a cold (uncached) Cost Explorer call shells out to the
      // AWS CLI, which routinely takes several seconds.
      const q = `/dashboard/costs?days=${days}${opts.refresh ? '&refresh=1' : ''}`
      const report = await hubFetch<CostReport>(q, { timeoutMs: 40_000 })
      set({ costs: report, costsLoading: false })
    } catch (err) {
      set({ costsLoading: false, costsError: (err as Error).message })
    }
  },

  setCostDays: (days) => {
    if (days === get().costDays) return
    localStorage.setItem(COST_DAYS_KEY, String(days))
    // Drop the stale window immediately so the chart can't show 30 days of data
    // under a "7d" label while the new fetch is in flight.
    set({ costDays: days, costs: null })
    void get().refreshCosts()
  },

  setCostStackBy: (by) => {
    localStorage.setItem(COST_STACK_KEY, by)
    set({ costStackBy: by }) // same data, different grouping — no refetch
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
