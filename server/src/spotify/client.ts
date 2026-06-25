// Spotify Web API client — the `spotify-tui` network layer ported to TS.
//
// This is a *remote control*: every playback method targets a Spotify Connect
// device (spotifyd). No audio is ever handled here. Auth tokens come from
// AuthStore (confidential client, proactive refresh). One retry on 401.

import type { AuthStore } from '../auth-store.js'
import type {
  RepeatState,
  SpotifyDevice,
  SpotifyPlayerSnapshot,
  SpotifyStatus,
  SpotifySearchResults,
  SpotifyTrackLite,
  SpotifyPlaylistLite,
  SpotifyNowPlayingItem,
} from './types.js'

const API = 'https://api.spotify.com/v1'

/** Preferred Connect device name (the local spotifyd). Override via env. */
const SPOTIFYD_DEVICE_NAME = process.env.SPOTIFY_DEVICE_NAME || 'amarhp-spotifyd'

export class SpotifyAuthError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SpotifyAuthError'
  }
}

export class SpotifyApiError extends Error {
  status: number
  retryAfter?: number
  constructor(status: number, msg: string, retryAfter?: number) {
    super(msg)
    this.name = status === 429 ? 'SpotifyRateLimitError' : 'SpotifyApiError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

export class SpotifyClient {
  private cachedSpotifydDeviceId: string | null = null
  private spotifydOnline = false

  constructor(private auth: AuthStore) {}

  // --------------------------------------------------------------------------
  // Core request helper
  // --------------------------------------------------------------------------

  private async token(): Promise<string> {
    const t = await this.auth.getSpotifyToken()
    if (!t) throw new SpotifyAuthError('Spotify not linked — authorize the account first')
    return t
  }

  /**
   * Issue a Web API request. Returns parsed JSON, or null for 204/empty.
   * Retries once after a forced token refresh on 401.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
    _retried = false,
  ): Promise<T | null> {
    const url = new URL(API + path)
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` }
    let body: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }

    // Hard timeout so a hung Spotify/network call can't seize every control
    // path (the hub has one client; an indefinite fetch would block all of it).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    let res: Response
    try {
      res = await fetch(url.toString(), { method, headers, body, signal: controller.signal })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new SpotifyApiError(504, 'Spotify request timed out')
      throw e
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 401 && !_retried) {
      // Token went stale mid-flight — force a refresh and retry once.
      await this.auth.refreshSpotifyToken()
      return this.request<T>(method, path, opts, true)
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1')
      throw new SpotifyApiError(429, 'Spotify rate limit', retryAfter)
    }
    if (res.status === 204 || res.status === 205) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new SpotifyApiError(res.status, `Spotify API ${res.status}: ${text || res.statusText}`)
    }
    // Spotify's player-control endpoints (play/pause/next/seek/…) now return
    // HTTP 200 with a bare command-id string instead of 204 No Content. Only
    // parse genuine JSON bodies; treat anything else as a successful no-content.
    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('application/json')) return null
    const text = await res.text()
    if (!text) return null
    return JSON.parse(text) as T
  }

  // --------------------------------------------------------------------------
  // Status / devices
  // --------------------------------------------------------------------------

  async getStatus(): Promise<SpotifyStatus> {
    const cfg = this.auth.getSpotifyConfig()
    const status: SpotifyStatus = {
      hasCredentials: !!cfg?.clientId && !!cfg?.clientSecret,
      connected: !!cfg?.accessToken,
      userId: cfg?.userId,
      displayName: cfg?.displayName,
      spotifydDeviceId: this.cachedSpotifydDeviceId,
      spotifydOnline: this.spotifydOnline,
    }
    if (status.connected) {
      try {
        await this.getDevices() // refreshes the spotifyd cache
        status.spotifydDeviceId = this.cachedSpotifydDeviceId
        status.spotifydOnline = this.spotifydOnline
      } catch {
        // leave cached values
      }
    }
    return status
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const data = await this.request<{ devices: RawDevice[] }>('GET', '/me/player/devices')
    const devices = (data?.devices ?? []).map(mapDevice)
    // Resolve + cache the spotifyd device for one-tap control.
    const spotifyd =
      devices.find((d) => d.name === SPOTIFYD_DEVICE_NAME) ??
      devices.find((d) => d.name.toLowerCase().includes('spotifyd'))
    this.spotifydOnline = !!spotifyd
    if (spotifyd?.id) this.cachedSpotifydDeviceId = spotifyd.id
    return devices
  }

  /** The device id control methods target by default (spotifyd). */
  getSpotifydDeviceId(): string | null {
    return this.cachedSpotifydDeviceId
  }

  // --------------------------------------------------------------------------
  // Now playing
  // --------------------------------------------------------------------------

  async getPlayer(): Promise<SpotifyPlayerSnapshot> {
    const cfg = this.auth.getSpotifyConfig()
    const linked = !!cfg?.accessToken
    const now = Date.now()
    if (!linked) return { ...emptySnapshot(), fetchedAt: now }

    const devices = await this.getDevices().catch(() => [] as SpotifyDevice[])
    const data = await this.request<RawPlayback>('GET', '/me/player', {
      query: { additional_types: 'track,episode' },
    })

    if (!data) {
      // 204 — nothing active.
      return {
        ...emptySnapshot(),
        linked: true,
        fetchedAt: now,
        devices,
        spotifydDeviceId: this.cachedSpotifydDeviceId,
      }
    }

    return {
      linked: true,
      isPlaying: !!data.is_playing,
      device: data.device ? mapDevice(data.device) : null,
      item: data.item ? mapItem(data.item) : null,
      progressMs: data.progress_ms ?? 0,
      shuffle: !!data.shuffle_state,
      repeat: (data.repeat_state as RepeatState) ?? 'off',
      fetchedAt: now,
      spotifydDeviceId: this.cachedSpotifydDeviceId,
      devices,
      disallows: data.actions?.disallows
        ? Object.keys(data.actions.disallows).filter((k) => data.actions!.disallows![k])
        : [],
    }
  }

  // --------------------------------------------------------------------------
  // Playback control — all default to the spotifyd device
  // --------------------------------------------------------------------------

  private device(deviceId?: string): string | undefined {
    return deviceId ?? this.cachedSpotifydDeviceId ?? undefined
  }

  async play(opts: {
    deviceId?: string
    contextUri?: string
    uris?: string[]
    offsetPosition?: number
    positionMs?: number
  } = {}): Promise<void> {
    const body: Record<string, unknown> = {}
    if (opts.contextUri) body.context_uri = opts.contextUri
    if (opts.uris) body.uris = opts.uris
    if (opts.offsetPosition !== undefined) body.offset = { position: opts.offsetPosition }
    if (opts.positionMs !== undefined) body.position_ms = opts.positionMs
    await this.request('PUT', '/me/player/play', {
      query: { device_id: this.device(opts.deviceId) },
      body: Object.keys(body).length ? body : undefined,
    })
  }

  async pause(deviceId?: string): Promise<void> {
    await this.request('PUT', '/me/player/pause', { query: { device_id: this.device(deviceId) } })
  }

  async next(deviceId?: string): Promise<void> {
    await this.request('POST', '/me/player/next', { query: { device_id: this.device(deviceId) } })
  }

  async previous(deviceId?: string): Promise<void> {
    await this.request('POST', '/me/player/previous', { query: { device_id: this.device(deviceId) } })
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    await this.request('PUT', '/me/player/seek', {
      query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: this.device(deviceId) },
    })
  }

  async setVolume(percent: number, deviceId?: string): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(percent)))
    await this.request('PUT', '/me/player/volume', { query: { volume_percent: v, device_id: this.device(deviceId) } })
  }

  async setShuffle(state: boolean, deviceId?: string): Promise<void> {
    await this.request('PUT', '/me/player/shuffle', { query: { state, device_id: this.device(deviceId) } })
  }

  async setRepeat(state: RepeatState, deviceId?: string): Promise<void> {
    await this.request('PUT', '/me/player/repeat', { query: { state, device_id: this.device(deviceId) } })
  }

  /** Transfer playback to a device (and optionally start playing on it). */
  async transfer(deviceId: string, play = true): Promise<void> {
    await this.request('PUT', '/me/player', { body: { device_ids: [deviceId], play } })
  }

  async queue(uri: string, deviceId?: string): Promise<void> {
    await this.request('POST', '/me/player/queue', { query: { uri, device_id: this.device(deviceId) } })
  }

  // --------------------------------------------------------------------------
  // Search / library
  // --------------------------------------------------------------------------

  async search(q: string, limit = 8): Promise<SpotifySearchResults> {
    const data = await this.request<RawSearch>('GET', '/search', {
      query: { q, type: 'track,album,artist,playlist', limit },
    })
    return {
      tracks: (data?.tracks?.items ?? []).map(mapTrack),
      albums: (data?.albums?.items ?? []).map((a) => ({
        id: a.id,
        uri: a.uri ?? null,
        name: a.name,
        artists: (a.artists ?? []).map((x) => x.name).join(', '),
        albumArt: a.images?.[0]?.url ?? null,
      })),
      artists: (data?.artists?.items ?? []).map((a) => ({
        id: a.id ?? null,
        uri: a.uri ?? '',
        name: a.name,
        image: a.images?.[0]?.url ?? null,
      })),
      playlists: (data?.playlists?.items ?? []).filter(Boolean).map(mapPlaylist),
    }
  }

  async getPlaylists(limit = 50): Promise<SpotifyPlaylistLite[]> {
    const data = await this.request<{ items: RawPlaylist[] }>('GET', '/me/playlists', { query: { limit } })
    return (data?.items ?? []).filter(Boolean).map(mapPlaylist)
  }

  async addToPlaylist(playlistId: string, uris: string[]): Promise<void> {
    await this.request('POST', `/playlists/${playlistId}/tracks`, { body: { uris } })
  }

  async removeFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
    await this.request('DELETE', `/playlists/${playlistId}/tracks`, {
      body: { tracks: uris.map((uri) => ({ uri })) },
    })
  }

  async getPlaylistTracks(playlistId: string, limit = 100, offset = 0): Promise<SpotifyTrackLite[]> {
    const data = await this.request<{ items: { track: RawItem | null }[] }>(
      'GET',
      `/playlists/${playlistId}/tracks`,
      { query: { limit, offset } },
    )
    return (data?.items ?? [])
      .map((i) => i.track)
      .filter((t): t is RawItem => !!t)
      .map(mapTrack)
  }

  async getSavedTracks(limit = 50, offset = 0): Promise<SpotifyTrackLite[]> {
    const data = await this.request<{ items: { track: RawItem }[] }>('GET', '/me/tracks', {
      query: { limit, offset },
    })
    return (data?.items ?? []).map((i) => i.track).map(mapTrack)
  }

  async saveTracks(ids: string[]): Promise<void> {
    await this.request('PUT', '/me/tracks', { query: { ids: ids.join(',') } })
  }

  async removeTracks(ids: string[]): Promise<void> {
    await this.request('DELETE', '/me/tracks', { query: { ids: ids.join(',') } })
  }

  async tracksContains(ids: string[]): Promise<boolean[]> {
    const data = await this.request<boolean[]>('GET', '/me/tracks/contains', { query: { ids: ids.join(',') } })
    return data ?? ids.map(() => false)
  }
}

// ---------------------------------------------------------------------------
// Raw Web API shapes + mappers (kept local — we only map what we use)
// ---------------------------------------------------------------------------

interface RawDevice {
  id: string | null
  is_active: boolean
  is_restricted: boolean
  name: string
  type: string
  volume_percent: number | null
}

interface RawArtist { name: string; id?: string | null; uri?: string; images?: { url: string }[] }
interface RawItem {
  type?: 'track' | 'episode'
  id: string | null
  uri: string
  name: string
  duration_ms: number
  artists?: RawArtist[]
  album?: { name: string; id?: string | null; uri?: string | null; images?: { url: string }[] }
  show?: { name: string; publisher?: string; images?: { url: string }[] }
  images?: { url: string }[]
}

interface RawPlayback {
  device: RawDevice | null
  shuffle_state: boolean
  repeat_state: string
  progress_ms: number | null
  is_playing: boolean
  item: RawItem | null
  currently_playing_type?: string
  actions?: { disallows?: Record<string, boolean> }
}

interface RawPlaylist {
  id: string
  uri: string
  name: string
  owner?: { display_name?: string; id?: string }
  tracks?: { total: number }
  images?: { url: string }[]
}

interface RawSearch {
  tracks?: { items: RawItem[] }
  albums?: { items: { id: string | null; uri?: string | null; name: string; artists?: RawArtist[]; images?: { url: string }[] }[] }
  artists?: { items: RawArtist[] }
  playlists?: { items: RawPlaylist[] }
}

function mapDevice(d: RawDevice): SpotifyDevice {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    isActive: d.is_active,
    isRestricted: d.is_restricted,
    volumePercent: d.volume_percent,
  }
}

function mapItem(item: RawItem): SpotifyNowPlayingItem {
  const isEpisode = item.type === 'episode' || (!item.artists && !!item.show)
  if (isEpisode) {
    return {
      type: 'episode',
      id: item.id,
      uri: item.uri,
      name: item.name,
      artists: item.show?.publisher || item.show?.name || '',
      album: item.show?.name || '',
      albumArt: item.images?.[0]?.url ?? item.show?.images?.[0]?.url ?? null,
      durationMs: item.duration_ms,
    }
  }
  return {
    type: 'track',
    id: item.id,
    uri: item.uri,
    name: item.name,
    artists: (item.artists ?? []).map((a) => a.name).join(', '),
    album: item.album?.name ?? '',
    albumArt: item.album?.images?.[0]?.url ?? null,
    durationMs: item.duration_ms,
  }
}

function mapTrack(item: RawItem): SpotifyTrackLite {
  return {
    id: item.id,
    uri: item.uri,
    name: item.name,
    artists: (item.artists ?? []).map((a) => a.name).join(', '),
    album: item.album?.name ?? '',
    albumArt: item.album?.images?.[0]?.url ?? null,
    durationMs: item.duration_ms,
  }
}

function mapPlaylist(p: RawPlaylist): SpotifyPlaylistLite {
  return {
    id: p.id,
    uri: p.uri,
    name: p.name,
    owner: p.owner?.display_name || p.owner?.id || '',
    trackCount: p.tracks?.total ?? 0,
    image: p.images?.[0]?.url ?? null,
  }
}

function emptySnapshot(): SpotifyPlayerSnapshot {
  return {
    linked: false,
    isPlaying: false,
    device: null,
    item: null,
    progressMs: 0,
    shuffle: false,
    repeat: 'off',
    fetchedAt: 0,
    spotifydDeviceId: null,
    devices: [],
    disallows: [],
  }
}
