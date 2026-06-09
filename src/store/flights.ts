// Flight watchlist store — wraps the hub's /flights/* endpoints.
//
// The hub polls watchlists on its own 1h tick and broadcasts `flights.polled`
// on the sync bus when results come in. This store mirrors that state for the
// calendar-sidebar panel so the UI stays in sync without dedicated polling.

import { create } from 'zustand'
import { hubFetch } from '@/hub'
import { hubBus } from '@/sync-bus'

export type WatchlistKind = 'explore' | 'route'

export type RegionKey = 'europe' | 'africa' | 'asia' | 'oceania' | 'northAmerica' | 'southAmerica'

export type TripDuration = 'Weekend' | '1 week' | '2 weeks'

export interface SearchSegment {
  from: string
  to: string
  departureTime?: string
  arrivalTime?: string
  airline?: string
  flightNumber?: string
  durationMin?: number
}

export interface WatchlistResult {
  label: string
  priceMajor: number

  // common
  startDate?: string
  endDate?: string
  departureTime?: string
  arrivalTime?: string

  // route-specific
  stops?: number
  airlines?: string[]
  flightNumbers?: string[]
  route?: string
  totalDurationMin?: number
  segments?: SearchSegment[]

  // explore-specific
  airport?: string
  country?: string
  kgmid?: string
  nonstop?: boolean
  link?: string

  raw?: unknown
}

export interface Watchlist {
  id: string
  label?: string
  kind: WatchlistKind
  origin: string
  currency: string
  maxPriceMajor?: number
  notifyOnDrop?: boolean
  createdAt: number
  // explore
  region?: RegionKey
  arrivalAreaId?: string
  destination?: string
  month?: number
  duration?: TripDuration
  // route
  outboundDate?: string
  returnDate?: string
  travelClass?: 1 | 2 | 3 | 4
  adults?: number
  // state
  lastCheckedAt?: number
  lastError?: string
  lastPriceMajor?: number
  history?: Array<{ at: number; priceMajor: number }>
  lastResults?: WatchlistResult[]
}

export interface CreateWatchlistInput {
  kind: WatchlistKind
  origin: string
  label?: string
  currency?: string
  maxPriceMajor?: number
  notifyOnDrop?: boolean
  region?: RegionKey
  destination?: string
  month?: number
  duration?: TripDuration
  outboundDate?: string
  returnDate?: string
  travelClass?: 1 | 2 | 3 | 4
  adults?: number
}

interface FlightsState {
  watchlists: Watchlist[]
  loading: boolean
  loaded: boolean
  configured: boolean | null
  expandedId: string | null
  showAddForm: boolean
  runningIds: Set<string>
  /** Mobile-only full-screen sheet visibility. Desktop renders the panel inline. */
  sheetOpen: boolean

  init: () => Promise<void>
  refresh: () => Promise<void>
  create: (input: CreateWatchlistInput) => Promise<Watchlist>
  remove: (id: string) => Promise<void>
  runOne: (id: string) => Promise<void>
  setExpanded: (id: string | null) => void
  setShowAddForm: (v: boolean) => void
  setSheetOpen: (v: boolean) => void
}

export const useFlightsStore = create<FlightsState>((set, get) => ({
  watchlists: [],
  loading: false,
  loaded: false,
  configured: null,
  expandedId: null,
  showAddForm: false,
  runningIds: new Set(),
  sheetOpen: false,

  async init() {
    if (get().loaded) return
    await Promise.all([get().refresh(), checkConfigured(set)])
    wireBus(set, get)
  },

  async refresh() {
    set({ loading: true })
    try {
      const data = await hubFetch<{ watchlists: Watchlist[] }>('/flights/watchlists')
      set({ watchlists: data.watchlists ?? [], loaded: true, loading: false })
    } catch (e) {
      console.error('[flights] refresh failed:', e)
      set({ loading: false })
    }
  },

  async create(input) {
    const wl = await hubFetch<Watchlist>('/flights/watchlists', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    set((s) => ({ watchlists: [...s.watchlists, wl], showAddForm: false }))
    return wl
  },

  async remove(id) {
    await hubFetch(`/flights/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' })
    set((s) => ({
      watchlists: s.watchlists.filter((w) => w.id !== id),
      expandedId: s.expandedId === id ? null : s.expandedId,
    }))
  },

  async runOne(id) {
    const running = new Set(get().runningIds)
    running.add(id)
    set({ runningIds: running })
    try {
      const updated = await hubFetch<Watchlist>(
        `/flights/watchlists/${encodeURIComponent(id)}/run`,
        { method: 'POST' },
      )
      set((s) => ({ watchlists: s.watchlists.map((w) => w.id === id ? updated : w) }))
    } catch (e) {
      console.error('[flights] runOne failed:', e)
    } finally {
      const r = new Set(get().runningIds)
      r.delete(id)
      set({ runningIds: r })
    }
  },

  setExpanded(id) { set({ expandedId: id }) },
  setShowAddForm(v) { set({ showAddForm: v }) },
  setSheetOpen(v) { set({ sheetOpen: v }) },
}))

async function checkConfigured(set: (partial: Partial<FlightsState>) => void): Promise<void> {
  try {
    const s = await hubFetch<{ configured: boolean }>('/flights/status')
    set({ configured: s.configured })
  } catch {
    set({ configured: false })
  }
}

function wireBus(
  set: (partial: Partial<FlightsState> | ((s: FlightsState) => Partial<FlightsState>)) => void,
  get: () => FlightsState,
): void {
  hubBus.on('flights', 'polled', (wl) => {
    const updated = wl as Watchlist
    set((s) => ({ watchlists: s.watchlists.map((w) => w.id === updated.id ? updated : w) }))
  })
  hubBus.on('flights', 'created', (wl) => {
    const created = wl as Watchlist
    set((s) => s.watchlists.some((w) => w.id === created.id) ? s : { watchlists: [...s.watchlists, created] })
  })
  hubBus.on('flights', 'updated', (wl) => {
    const updated = wl as Watchlist
    set((s) => ({ watchlists: s.watchlists.map((w) => w.id === updated.id ? updated : w) }))
  })
  hubBus.on('flights', 'deleted', (payload) => {
    const id = (payload as { id?: string })?.id
    if (!id) return
    set((s) => ({
      watchlists: s.watchlists.filter((w) => w.id !== id),
      expandedId: s.expandedId === id ? null : s.expandedId,
    }))
  })
  void get // silence unused
}
