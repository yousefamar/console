// Music (Spotify) store — mirrors the hub's now-playing snapshot and exposes
// control actions. The hub is a remote control over the Web API; playback runs
// on the spotifyd Connect device. Control also happens via system media keys
// (Sway → `con music …`), so this store just needs to reflect + offer buttons.

import { create } from 'zustand'
import { hubFetch } from '@/hub'
import { useUiStore } from '@/store/ui'

export interface MusicDevice {
  id: string | null
  name: string
  type: string
  isActive: boolean
  volumePercent: number | null
}

export interface MusicItem {
  type: 'track' | 'episode'
  id: string | null
  uri: string
  name: string
  artists: string
  album: string
  albumArt: string | null
  durationMs: number
}

export interface MusicSnapshot {
  linked: boolean
  isPlaying: boolean
  device: MusicDevice | null
  item: MusicItem | null
  progressMs: number
  shuffle: boolean
  repeat: 'off' | 'context' | 'track'
  fetchedAt: number
  spotifydDeviceId: string | null
  devices: MusicDevice[]
  disallows: string[]
}

export interface MusicTrack {
  id: string | null
  uri: string
  name: string
  artists: string
  album: string
  albumArt: string | null
  durationMs: number
}

export interface MusicPlaylist {
  id: string
  uri: string
  name: string
  owner: string
  trackCount: number
  image: string | null
}

interface MusicState {
  open: boolean
  snapshot: MusicSnapshot | null
  searchQuery: string
  searchResults: MusicTrack[]
  searching: boolean
  playlists: MusicPlaylist[]
  currentLiked: boolean

  setOpen: (open: boolean) => void
  toggleOpen: () => void
  setSnapshot: (snap: MusicSnapshot) => void

  loadPlaylists: () => Promise<void>
  playLiked: () => Promise<void>
  checkLiked: () => Promise<void>
  toggleLike: () => Promise<void>
  addCurrentToPlaylist: (playlistId: string) => Promise<void>

  refresh: () => Promise<void>
  togglePlay: () => Promise<void>
  next: () => Promise<void>
  previous: () => Promise<void>
  seek: (positionMs: number) => Promise<void>
  setVolume: (percent: number) => Promise<void>
  toggleShuffle: () => Promise<void>
  cycleRepeat: () => Promise<void>
  playUri: (uri: string) => Promise<void>
  queueUri: (uri: string) => Promise<void>
  transfer: (deviceId: string) => Promise<void>
  search: (q: string) => Promise<void>
  clearSearch: () => void
}

/** Map a hub control error to a friendly toast. Never let control fail silently. */
function toastControlError(e: unknown): void {
  const raw = e instanceof Error ? e.message : String(e)
  let detail: string | undefined
  try {
    const parsed = JSON.parse(raw) as { error?: string }
    if (parsed.error) detail = parsed.error
  } catch {
    detail = raw
  }
  const blob = `${detail ?? ''} ${raw}`
  let message = 'Spotify control failed'
  if (/device not found|no_active_device|no active device/i.test(blob)) {
    message = 'No playback device'
    detail = 'Open Spotify on a device, pick amarhp-spotifyd in the Connect menu and play, then try again.'
  } else if (/restriction|\b403\b/i.test(blob)) {
    message = 'Not supported by this device'
    detail = undefined
  } else if (/not linked|not configured|\b401\b/i.test(blob)) {
    message = 'Spotify not linked'
    detail = 'Reconnect Spotify from the music drawer.'
  }
  useUiStore.getState().pushToast({ kind: 'error', message, detail })
}

async function post(path: string, body?: unknown): Promise<void> {
  try {
    await hubFetch(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })
  } catch (e) {
    toastControlError(e)
    // Re-sync so optimistic UI doesn't keep lying after a failure.
    void useMusicStore.getState().refresh()
  }
}

export const useMusicStore = create<MusicState>((set, get) => ({
  open: false,
  snapshot: null,
  searchQuery: '',
  searchResults: [],
  searching: false,
  playlists: [],
  currentLiked: false,

  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setSnapshot: (snapshot) => set({ snapshot }),

  loadPlaylists: async () => {
    try {
      const r = await hubFetch<{ playlists: MusicPlaylist[] }>('/spotify/playlists')
      set({ playlists: r.playlists ?? [] })
    } catch {
      // leave previous
    }
  },

  playLiked: async () => {
    try {
      const r = await hubFetch<{ tracks: MusicTrack[] }>('/spotify/saved-tracks?limit=50')
      const uris = (r.tracks ?? []).map((t) => t.uri)
      if (uris.length) await post('/spotify/play', { uris })
    } catch {
      // ignore
    }
  },

  checkLiked: async () => {
    const id = get().snapshot?.item?.id
    if (!id) {
      set({ currentLiked: false })
      return
    }
    try {
      const r = await hubFetch<{ saved: boolean[] }>(`/spotify/saved?ids=${id}`)
      set({ currentLiked: !!r.saved?.[0] })
    } catch {
      // ignore
    }
  },

  toggleLike: async () => {
    const id = get().snapshot?.item?.id
    if (!id) return
    const liked = get().currentLiked
    set({ currentLiked: !liked }) // optimistic
    await post(liked ? '/spotify/unsave' : '/spotify/save', { ids: [id] })
  },

  addCurrentToPlaylist: async (playlistId) => {
    const uri = get().snapshot?.item?.uri
    if (!uri) return
    await post(`/spotify/playlist/${playlistId}/add`, { uris: [uri] })
  },

  refresh: async () => {
    try {
      const snap = await hubFetch<MusicSnapshot>('/spotify/player')
      set({ snapshot: snap })
    } catch {
      // leave previous snapshot
    }
  },

  togglePlay: async () => {
    // Optimistic: flip the play icon immediately.
    const snap = get().snapshot
    if (snap) set({ snapshot: { ...snap, isPlaying: !snap.isPlaying, fetchedAt: Date.now() } })
    await post('/spotify/toggle')
  },

  next: async () => { await post('/spotify/next') },
  previous: async () => { await post('/spotify/previous') },

  seek: async (positionMs) => {
    const snap = get().snapshot
    if (snap) set({ snapshot: { ...snap, progressMs: positionMs, fetchedAt: Date.now() } })
    await post('/spotify/seek', { positionMs: Math.round(positionMs) })
  },

  setVolume: async (percent) => {
    const snap = get().snapshot
    const v = Math.max(0, Math.min(100, Math.round(percent)))
    if (snap?.device) set({ snapshot: { ...snap, device: { ...snap.device, volumePercent: v } } })
    await post('/spotify/volume', { percent: v })
  },

  toggleShuffle: async () => {
    const snap = get().snapshot
    const state = !snap?.shuffle
    if (snap) set({ snapshot: { ...snap, shuffle: state } })
    await post('/spotify/shuffle', { state })
  },

  cycleRepeat: async () => {
    const snap = get().snapshot
    const cur = snap?.repeat ?? 'off'
    const state = cur === 'off' ? 'context' : cur === 'context' ? 'track' : 'off'
    if (snap) set({ snapshot: { ...snap, repeat: state } })
    await post('/spotify/repeat', { state })
  },

  playUri: async (uri) => {
    const body = uri.includes(':track:') ? { uris: [uri] } : { contextUri: uri }
    await post('/spotify/play', body)
  },

  queueUri: async (uri) => { await post('/spotify/queue', { uri }) },

  transfer: async (deviceId) => { await post('/spotify/transfer', { deviceId, play: true }) },

  search: async (q) => {
    set({ searchQuery: q, searching: true })
    if (!q.trim()) {
      set({ searchResults: [], searching: false })
      return
    }
    try {
      const r = await hubFetch<{ tracks: MusicTrack[] }>(`/spotify/search?q=${encodeURIComponent(q)}&limit=12`)
      // Ignore stale responses if the query changed while in flight.
      if (get().searchQuery === q) set({ searchResults: r.tracks ?? [], searching: false })
    } catch {
      set({ searching: false })
    }
  },

  clearSearch: () => set({ searchQuery: '', searchResults: [] }),
}))
