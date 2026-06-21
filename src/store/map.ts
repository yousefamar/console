import { create } from 'zustand'
import { hubFetch } from '@/hub'

// --- OwnTracks --------------------------------------------------------------

export interface OtFix {
  lat: number
  lon: number
  tst: number // unix seconds
  device?: string
  tid?: string
  acc?: number
  alt?: number
  batt?: number
  vel?: number
  isolocal?: string
}

// --- Geocaches (mirror of the hub summary shape) ----------------------------

export interface MapCache {
  code: string
  name: string
  lat: number | null
  lon: number | null
  type: string
  size: string
  difficulty: number
  terrain: number
  found: boolean
  dnf: boolean
  pmOnly: boolean
  owner: string
  hidden: string
  favorites: number
  status: string
  detail?: {
    hint: string
    description: string
    attributes: { slug: string; label: string; enabled: boolean }[]
    logs: { id: string; type: string; text: string; date: string; author: string }[]
    waypoints: { id: string; type: string; lat: number | null; lon: number | null; note: string }[]
    fetchedAt: number
  }
}

export interface GcStatus {
  loggedIn: boolean
  username: string | null
  hasCredentials: boolean
  budget: { used: number; cap: number; remaining: number }
  cacheCount: number
}

export type BBox = [number, number, number, number] // [s, w, n, e]

// --- Agent-authored layers --------------------------------------------------

export interface MapLayerStyle {
  color?: string
  size?: number
  fillColor?: string
  fillOpacity?: number
  strokeColor?: string
  strokeWidth?: number
  lineColor?: string
  lineWidth?: number
  popup?: Array<string | { key: string; label?: string }>
}

export interface MapLayerMeta {
  slug: string
  group: string
  name: string
  geometryTypes: string[]
  featureCount: number
  bbox: [number, number, number, number] | null // [w, s, e, n]
  style: MapLayerStyle
  fit: boolean
  updatedAt: number
  updatedBy?: string
}

const LAYER_VIS_KEY = 'console:map:layerVisible'
function loadLayerVis(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(LAYER_VIS_KEY) || '{}')
  } catch {
    return {}
  }
}
function saveLayerVis(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(LAYER_VIS_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

const DAY = 24 * 60 * 60 * 1000
const OT_USER = 'amar'

function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface MapState {
  // OwnTracks
  current: OtFix[] // latest fix per device
  devices: string[]
  device: string | null // selected device for history
  track: OtFix[] // history points for the selected range
  rangeFrom: number // epoch ms
  rangeTo: number // epoch ms
  loadingHistory: boolean

  // Geocaches
  pins: MapCache[]
  selectedCode: string | null
  gcStatus: GcStatus | null
  fetching: boolean
  error: string | null

  // actions
  refresh: () => Promise<void>
  loadHistory: (fromMs?: number, toMs?: number, device?: string) => Promise<void>
  setRange: (fromMs: number, toMs: number) => void
  fetchArea: (bbox: BBox, max?: number) => Promise<void>
  loadPins: () => Promise<void>
  mergePins: (incoming: MapCache[]) => void
  selectCache: (code: string | null) => Promise<void>

  // agent-authored layers
  layers: MapLayerMeta[]
  layerData: Record<string, unknown> // slug → geojson
  layerVisible: Record<string, boolean>
  setLayers: (metas: MapLayerMeta[]) => void
  setLayerData: (slug: string, geojson: unknown) => void
  toggleLayer: (slug: string) => void
  setGroupVisible: (group: string, visible: boolean) => void
  setCredentials: (creds: { username?: string; password?: string; cookie?: string }) => Promise<void>
  selectAdjacentPin: (dir: 1 | -1) => void
}

export const useMapStore = create<MapState>((set, get) => ({
  current: [],
  devices: [],
  device: null,
  track: [],
  rangeFrom: Date.now() - 7 * DAY,
  rangeTo: Date.now(),
  loadingHistory: false,

  pins: [],
  selectedCode: null,
  gcStatus: null,
  fetching: false,
  error: null,

  refresh: async () => {
    try {
      const [last, status] = await Promise.all([
        hubFetch<OtFix[]>('/owntracks/last').catch(() => [] as OtFix[]),
        hubFetch<GcStatus>('/geocaching/status').catch(() => null),
      ])
      const devices = [...new Set(last.map((f) => f.device).filter(Boolean) as string[])]
      set((s) => ({
        current: last,
        devices,
        device: s.device ?? devices[0] ?? null,
        gcStatus: status,
      }))
      await get().loadPins()
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  loadHistory: async (fromMs, toMs, device) => {
    const s = get()
    const from = fromMs ?? s.rangeFrom
    const to = toMs ?? s.rangeTo
    const dev = device ?? s.device ?? s.devices[0]
    if (!dev) return
    set({ loadingHistory: true, rangeFrom: from, rangeTo: to, device: dev })
    try {
      const params = new URLSearchParams({
        user: OT_USER,
        device: dev,
        from: ymd(from),
        to: ymd(to + DAY), // inclusive of the end day
        format: 'json',
      })
      const resp = await hubFetch<{ data?: OtFix[] } | OtFix[]>(`/owntracks/locations?${params.toString()}`)
      const data = Array.isArray(resp) ? resp : (resp.data ?? [])
      // newest-last so the polyline draws in chronological order
      const track = data.filter((f) => typeof f.lat === 'number').sort((a, b) => a.tst - b.tst)
      set({ track, loadingHistory: false })
    } catch (err) {
      set({ loadingHistory: false, error: (err as Error).message })
    }
  },

  setRange: (fromMs, toMs) => set({ rangeFrom: fromMs, rangeTo: toMs }),

  loadPins: async () => {
    try {
      const snap = await hubFetch<{ caches: MapCache[] }>('/geocaching/caches')
      get().mergePins(snap.caches ?? [])
    } catch (err) {
      // offline / hub down — the Dexie-hydrated pins from the subscriber remain.
      set({ error: (err as Error).message })
    }
  },

  fetchArea: async (bbox, max) => {
    set({ fetching: true, error: null })
    try {
      const result = await hubFetch<{ added: number; total: number; budget: GcStatus['budget'] }>(
        '/geocaching/fetch-area',
        { method: 'POST', body: JSON.stringify({ bbox, max }) },
      )
      set((s) => ({ gcStatus: s.gcStatus ? { ...s.gcStatus, budget: result.budget } : s.gcStatus }))
      await get().loadPins()
    } catch (err) {
      set({ error: (err as Error).message })
      throw err
    } finally {
      set({ fetching: false })
    }
  },

  mergePins: (incoming) =>
    set((s) => {
      const byCode = new Map(s.pins.map((p) => [p.code, p]))
      for (const c of incoming) {
        const prev = byCode.get(c.code)
        // Preserve any locally-loaded detail across a summary refresh.
        byCode.set(c.code, prev?.detail && !c.detail ? { ...c, detail: prev.detail } : c)
      }
      return { pins: [...byCode.values()] }
    }),

  selectCache: async (code) => {
    set({ selectedCode: code })
    if (!code) return
    const existing = get().pins.find((p) => p.code === code)
    if (existing?.detail) return
    try {
      const full = await hubFetch<MapCache>(`/geocaching/cache/${code}`)
      set((s) => ({ pins: s.pins.map((p) => (p.code === code ? { ...p, ...full } : p)) }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  setCredentials: async (creds) => {
    set({ error: null })
    const status = await hubFetch<GcStatus>('/geocaching/credentials', {
      method: 'POST',
      body: JSON.stringify(creds),
    })
    set({ gcStatus: status })
  },

  layers: [],
  layerData: {},
  layerVisible: loadLayerVis(),
  setLayers: (metas) => set({ layers: metas }),
  setLayerData: (slug, geojson) => set((s) => ({ layerData: { ...s.layerData, [slug]: geojson } })),
  toggleLayer: (slug) =>
    set((s) => {
      const visible = s.layerVisible[slug] !== false
      const next = { ...s.layerVisible, [slug]: !visible }
      saveLayerVis(next)
      return { layerVisible: next }
    }),
  setGroupVisible: (group, visible) =>
    set((s) => {
      const next = { ...s.layerVisible }
      for (const l of s.layers) if (l.group === group || l.slug === group) next[l.slug] = visible
      saveLayerVis(next)
      return { layerVisible: next }
    }),

  selectAdjacentPin: (dir) => {
    const { pins, selectedCode } = get()
    const withCoords = pins.filter((p) => p.lat != null && p.lon != null)
    if (withCoords.length === 0) return
    const idx = withCoords.findIndex((p) => p.code === selectedCode)
    const next = withCoords[(idx + dir + withCoords.length) % withCoords.length]
    if (next) void get().selectCache(next.code)
  },
}))
