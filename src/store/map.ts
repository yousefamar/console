import { create } from 'zustand'
import { hubFetch } from '@/hub'

// Places Autocomplete session token: groups a burst of keystrokes + the final
// details fetch into one billable session. Rotated after each details fetch.
let _gmapsSession: string | null = null
function gmapsSessionToken(): string {
  if (!_gmapsSession) _gmapsSession = crypto.randomUUID()
  return _gmapsSession
}
function resetGmapsSession(): void {
  _gmapsSession = null
}

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

// --- Meetup events (mirror of the hub summary shape) ------------------------

export interface MeetupEvent {
  id: string
  title: string
  dateTime: string // ISO 8601 with offset
  endTime: string
  eventUrl: string
  eventType: 'PHYSICAL' | 'ONLINE' | 'HYBRID'
  isOnline: boolean
  going: number
  groupName: string
  groupUrlname: string
  venueName: string
  venueAddress: string
  venueCity: string
  lat: number | null
  lon: number | null
  detail?: { description: string; fetchedAt: number }
}

export interface MeetupStatus {
  budget: { used: number; cap: number; remaining: number }
  eventCount: number
  lastFetch: number
}

// --- Google Maps (search + directions) --------------------------------------

export interface GPlace {
  id: string
  name: string
  address?: string
  lat: number
  lon: number
  types?: string[]
  rating?: number
  userRatingCount?: number
  googleMapsUri?: string
}

export interface GSuggestion {
  placeId: string
  text: string
  mainText: string
  secondaryText?: string
}

export type GTravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT'

export interface GRoute {
  description?: string
  durationSec: number
  distanceMeters: number
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

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
  animated?: boolean
  popup?: Array<string | { key: string; label?: string }>
  /** open a rich side panel (image, summary, link) on click instead of a popup. */
  panel?: boolean
}

/** A clicked feature from an agent layer whose style asks for a panel. */
export interface LayerFeatureSel {
  slug: string
  props: Record<string, unknown>
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

// The three hub-backed overlays (location history, geocaches, Meetup) are
// modelled as "built-in layers": they live in the same Layers panel as the
// agent-pushed layers and each owns a toolbar control cluster that renders
// only while the layer is visible. Visibility persists like agent layers.
export type BuiltinLayerId = 'location' | 'geocaches' | 'meetup'
const BUILTIN_VIS_KEY = 'console:map:builtinVisible'
function loadBuiltinVis(): Record<BuiltinLayerId, boolean> {
  const def = { location: true, geocaches: true, meetup: true }
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(BUILTIN_VIS_KEY) || '{}') }
  } catch {
    return def
  }
}
function saveBuiltinVis(v: Record<BuiltinLayerId, boolean>): void {
  try {
    localStorage.setItem(BUILTIN_VIS_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

const DAY = 24 * 60 * 60 * 1000
const OT_USER = 'amar'
const MAX_TRACK_POINTS = 4000 // decimate wide ranges so the polyline stays fast

function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Even-sample an array down to `max` items, always keeping the last. */
function decimate<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr
  const step = arr.length / max
  const out: T[] = []
  for (let i = 0; i < arr.length; i += step) {
    const item = arr[Math.floor(i)]
    if (item !== undefined) out.push(item)
  }
  const last = arr[arr.length - 1]
  if (last !== undefined && out[out.length - 1] !== last) out.push(last)
  return out
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

  // Meetup events
  events: MeetupEvent[]
  selectedEventId: string | null
  meetupStatus: MeetupStatus | null
  fetchingMeetup: boolean
  meetupQuery: string
  meetupDays: number // 0 = upcoming (no end bound); else next N days

  // actions
  refresh: () => Promise<void>
  loadHistory: (fromMs?: number, toMs?: number, device?: string) => Promise<void>
  setRange: (fromMs: number, toMs: number) => void
  fetchArea: (bbox: BBox, max?: number) => Promise<void>
  loadPins: () => Promise<void>
  mergePins: (incoming: MapCache[]) => void
  selectCache: (code: string | null) => Promise<void>

  // Meetup actions
  fetchMeetupArea: (bbox: BBox) => Promise<void>
  loadEvents: () => Promise<void>
  mergeEvents: (incoming: MeetupEvent[]) => void
  selectEvent: (id: string | null) => Promise<void>
  selectAdjacentEvent: (dir: 1 | -1) => void
  setMeetupQuery: (q: string) => void
  setMeetupDays: (d: number) => void

  // Google Maps search + directions
  gmapsConfigured: boolean | null // null = not yet probed
  gmapsQuery: string
  gmapsResults: GPlace[]
  gmapsSelectedPlaceId: string | null
  gmapsSearching: boolean
  // type-ahead autocomplete
  gmapsSuggestions: GSuggestion[]
  gmapsSuggesting: boolean
  // directions: origin/destination places + the computed routes
  gmapsRouteFrom: GPlace | null
  gmapsRouteTo: GPlace | null
  gmapsMode: GTravelMode
  gmapsRoutes: GRoute[]
  gmapsSelectedRoute: number // index into gmapsRoutes
  gmapsRouting: boolean
  gmapsError: string | null
  probeGmaps: () => Promise<void>
  setGmapsKey: (apiKey: string) => Promise<void>
  setGmapsQuery: (q: string) => void
  searchGmaps: (query: string, bias?: { lat: number; lon: number; radiusMeters?: number }) => Promise<void>
  autocompleteGmaps: (query: string, bias?: { lat: number; lon: number }) => Promise<void>
  pickSuggestion: (placeId: string) => Promise<void>
  clearSuggestions: () => void
  selectPlace: (id: string | null) => void
  clearGmapsSearch: () => void
  setRouteFrom: (p: GPlace | null) => void
  setRouteTo: (p: GPlace | null) => void
  setGmapsMode: (m: GTravelMode) => void
  computeDirections: () => Promise<void>
  selectRoute: (idx: number) => void
  clearDirections: () => void

  // built-in layers (hub-backed overlays surfaced in the Layers panel)
  builtinVisible: Record<BuiltinLayerId, boolean>
  toggleBuiltin: (id: BuiltinLayerId) => void

  // agent-authored layers
  layers: MapLayerMeta[]
  layerData: Record<string, unknown> // slug → geojson
  layerVisible: Record<string, boolean>
  selectedLayerFeature: LayerFeatureSel | null
  loadLayers: () => Promise<void>
  setLayers: (metas: MapLayerMeta[]) => void
  setLayerData: (slug: string, geojson: unknown) => void
  toggleLayer: (slug: string) => void
  setGroupVisible: (group: string, visible: boolean) => void
  selectLayerFeature: (sel: LayerFeatureSel | null) => void
  setCredentials: (creds: { username?: string; password?: string; cookie?: string }) => Promise<void>
  selectAdjacentPin: (dir: 1 | -1) => void
}

export const useMapStore = create<MapState>((set, get) => ({
  current: [],
  devices: [],
  device: null,
  track: [],
  rangeFrom: Date.now() - 1 * DAY,
  rangeTo: Date.now(),
  loadingHistory: false,

  pins: [],
  selectedCode: null,
  gcStatus: null,
  fetching: false,
  error: null,

  events: [],
  selectedEventId: null,
  meetupStatus: null,
  fetchingMeetup: false,
  meetupQuery: '',
  meetupDays: 0,

  refresh: async () => {
    try {
      const [last, status, meetupStatus] = await Promise.all([
        hubFetch<OtFix[]>('/owntracks/last').catch(() => [] as OtFix[]),
        hubFetch<GcStatus>('/geocaching/status').catch(() => null),
        hubFetch<MeetupStatus>('/meetup/status').catch(() => null),
      ])
      const devices = [...new Set(last.map((f) => f.device).filter(Boolean) as string[])]
      set((s) => ({
        current: last,
        devices,
        device: s.device && devices.includes(s.device) ? s.device : (devices[0] ?? null),
        gcStatus: status,
        meetupStatus,
      }))
      await Promise.all([get().loadPins(), get().loadEvents()])
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
      const sorted = data.filter((f) => typeof f.lat === 'number').sort((a, b) => a.tst - b.tst)
      set({ track: decimate(sorted, MAX_TRACK_POINTS), loadingHistory: false })
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
    set({ selectedCode: code, selectedEventId: null })
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

  loadEvents: async () => {
    try {
      const snap = await hubFetch<{ events: MeetupEvent[] }>('/meetup/events')
      get().mergeEvents(snap.events ?? [])
    } catch (err) {
      // offline / hub down — the Dexie-hydrated events from the subscriber remain.
      set({ error: (err as Error).message })
    }
  },

  fetchMeetupArea: async (bbox) => {
    set({ fetchingMeetup: true, error: null })
    try {
      const { meetupQuery, meetupDays } = get()
      const result = await hubFetch<{ added: number; total: number; budget: MeetupStatus['budget'] }>(
        '/meetup/fetch-area',
        {
          method: 'POST',
          body: JSON.stringify({
            bbox,
            query: meetupQuery.trim() || undefined,
            days: meetupDays || undefined,
          }),
        },
      )
      set((s) => ({ meetupStatus: s.meetupStatus ? { ...s.meetupStatus, budget: result.budget } : s.meetupStatus }))
      await get().loadEvents()
    } catch (err) {
      set({ error: (err as Error).message })
      throw err
    } finally {
      set({ fetchingMeetup: false })
    }
  },

  mergeEvents: (incoming) =>
    set((s) => {
      const byId = new Map(s.events.map((e) => [e.id, e]))
      for (const ev of incoming) {
        const prev = byId.get(ev.id)
        // Preserve any locally-loaded detail across a summary refresh.
        byId.set(ev.id, prev?.detail && !ev.detail ? { ...ev, detail: prev.detail } : ev)
      }
      return { events: [...byId.values()] }
    }),

  selectEvent: async (id) => {
    set({ selectedEventId: id, selectedCode: null })
    if (!id) return
    const existing = get().events.find((e) => e.id === id)
    if (existing?.detail) return
    try {
      const full = await hubFetch<MeetupEvent>(`/meetup/event/${encodeURIComponent(id)}`)
      set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...full } : e)) }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  selectAdjacentEvent: (dir) => {
    const { events, selectedEventId } = get()
    const onMap = events
      .filter((e) => e.lat != null && e.lon != null)
      .sort((a, b) => a.dateTime.localeCompare(b.dateTime))
    if (onMap.length === 0) return
    const idx = onMap.findIndex((e) => e.id === selectedEventId)
    const next = onMap[(idx + dir + onMap.length) % onMap.length]
    if (next) void get().selectEvent(next.id)
  },

  setMeetupQuery: (q) => set({ meetupQuery: q }),
  setMeetupDays: (d) => set({ meetupDays: d }),

  gmapsConfigured: null,
  gmapsQuery: '',
  gmapsResults: [],
  gmapsSelectedPlaceId: null,
  gmapsSearching: false,
  gmapsSuggestions: [],
  gmapsSuggesting: false,
  gmapsRouteFrom: null,
  gmapsRouteTo: null,
  gmapsMode: 'DRIVE',
  gmapsRoutes: [],
  gmapsSelectedRoute: 0,
  gmapsRouting: false,
  gmapsError: null,

  probeGmaps: async () => {
    try {
      const { configured } = await hubFetch<{ configured: boolean }>('/gmaps/status')
      set({ gmapsConfigured: configured })
    } catch {
      set({ gmapsConfigured: false })
    }
  },

  setGmapsKey: async (apiKey) => {
    await hubFetch('/gmaps/credentials', { method: 'POST', body: JSON.stringify({ apiKey }) })
    set({ gmapsConfigured: true, gmapsError: null })
  },

  setGmapsQuery: (q) => set({ gmapsQuery: q }),

  searchGmaps: async (query, bias) => {
    const q = query.trim()
    if (!q) return
    set({ gmapsSearching: true, gmapsError: null })
    try {
      const params = new URLSearchParams({ q })
      if (bias) {
        params.set('lat', String(bias.lat))
        params.set('lon', String(bias.lon))
        if (bias.radiusMeters) params.set('radius', String(bias.radiusMeters))
      }
      const { results } = await hubFetch<{ results: GPlace[] }>(`/gmaps/search?${params.toString()}`)
      set({ gmapsResults: results, gmapsSelectedPlaceId: results[0]?.id ?? null })
    } catch (err) {
      set({ gmapsError: (err as Error).message, gmapsResults: [] })
    } finally {
      set({ gmapsSearching: false })
    }
  },

  autocompleteGmaps: async (query, bias) => {
    const q = query.trim()
    if (q.length < 2) {
      set({ gmapsSuggestions: [], gmapsSuggesting: false })
      return
    }
    set({ gmapsSuggesting: true })
    try {
      const params = new URLSearchParams({ q, session: gmapsSessionToken() })
      if (bias) {
        params.set('lat', String(bias.lat))
        params.set('lon', String(bias.lon))
      }
      const { suggestions } = await hubFetch<{ suggestions: GSuggestion[] }>(`/gmaps/autocomplete?${params.toString()}`)
      // ignore a stale response if the query moved on
      if (get().gmapsQuery.trim() === q) set({ gmapsSuggestions: suggestions })
    } catch {
      set({ gmapsSuggestions: [] })
    } finally {
      set({ gmapsSuggesting: false })
    }
  },

  pickSuggestion: async (placeId) => {
    set({ gmapsSuggestions: [], gmapsSearching: true, gmapsError: null })
    try {
      const params = new URLSearchParams({ session: gmapsSessionToken() })
      const { place } = await hubFetch<{ place: GPlace }>(`/gmaps/place/${encodeURIComponent(placeId)}?${params.toString()}`)
      resetGmapsSession() // a details fetch ends the billing session
      set({ gmapsResults: [place], gmapsSelectedPlaceId: place.id, gmapsQuery: place.name })
    } catch (err) {
      set({ gmapsError: (err as Error).message })
    } finally {
      set({ gmapsSearching: false })
    }
  },

  clearSuggestions: () => set({ gmapsSuggestions: [] }),

  selectPlace: (id) => set({ gmapsSelectedPlaceId: id }),
  clearGmapsSearch: () => set({ gmapsResults: [], gmapsSelectedPlaceId: null, gmapsQuery: '', gmapsSuggestions: [] }),

  setRouteFrom: (p) => set({ gmapsRouteFrom: p }),
  setRouteTo: (p) => set({ gmapsRouteTo: p }),
  setGmapsMode: (m) => set({ gmapsMode: m }),

  computeDirections: async () => {
    const { gmapsRouteFrom, gmapsRouteTo, gmapsMode } = get()
    if (!gmapsRouteFrom || !gmapsRouteTo) return
    set({ gmapsRouting: true, gmapsError: null })
    try {
      const { routes } = await hubFetch<{ routes: GRoute[] }>('/gmaps/directions', {
        method: 'POST',
        body: JSON.stringify({
          origin: { lat: gmapsRouteFrom.lat, lon: gmapsRouteFrom.lon },
          destination: { lat: gmapsRouteTo.lat, lon: gmapsRouteTo.lon },
          mode: gmapsMode,
          alternatives: true,
        }),
      })
      set({ gmapsRoutes: routes, gmapsSelectedRoute: 0 })
    } catch (err) {
      set({ gmapsError: (err as Error).message, gmapsRoutes: [] })
    } finally {
      set({ gmapsRouting: false })
    }
  },

  selectRoute: (idx) => set({ gmapsSelectedRoute: idx }),
  clearDirections: () => set({ gmapsRouteFrom: null, gmapsRouteTo: null, gmapsRoutes: [], gmapsSelectedRoute: 0 }),

  builtinVisible: loadBuiltinVis(),
  toggleBuiltin: (id) =>
    set((s) => {
      const next = { ...s.builtinVisible, [id]: !s.builtinVisible[id] }
      saveBuiltinVis(next)
      return { builtinVisible: next }
    }),

  layers: [],
  layerData: {},
  layerVisible: loadLayerVis(),
  selectedLayerFeature: null,
  selectLayerFeature: (sel) => set({ selectedLayerFeature: sel }),
  loadLayers: async () => {
    try {
      const { layers } = await hubFetch<{ layers: MapLayerMeta[] }>('/map/layers')
      set({ layers })
      for (const l of layers) {
        try {
          get().setLayerData(l.slug, await hubFetch<unknown>(`/map/layers/${encodeURIComponent(l.slug)}`))
        } catch {
          /* skip a layer that fails to fetch */
        }
      }
    } catch {
      /* offline — Dexie-hydrated layers (if any) remain */
    }
  },
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
