// Spotify subsystem — shared types.
//
// The hub is a *remote control* over the Spotify Web API, not a player. All
// playback happens on a Spotify Connect device (spotifyd). These types model
// the small slice of state the Console drawer needs, plus the search/library
// payloads the CLI and UI consume.

export type RepeatState = 'off' | 'context' | 'track'

export interface SpotifyDevice {
  id: string | null
  name: string
  type: string
  isActive: boolean
  isRestricted: boolean
  volumePercent: number | null
}

export interface SpotifyNowPlayingItem {
  type: 'track' | 'episode'
  id: string | null
  uri: string
  name: string
  /** Joined artist names (track) or show publisher (episode). */
  artists: string
  album: string
  albumArt: string | null
  durationMs: number
}

/**
 * The authoritative now-playing snapshot the hub broadcasts over SyncBus.
 * Deliberately tiny (full-snapshot broadcast on every change is fine).
 */
export interface SpotifyPlayerSnapshot {
  /** True once Spotify creds + tokens exist; false means "link your account". */
  linked: boolean
  isPlaying: boolean
  device: SpotifyDevice | null
  item: SpotifyNowPlayingItem | null
  progressMs: number
  shuffle: boolean
  repeat: RepeatState
  /** Wall-clock ms when the snapshot was fetched — clients interpolate progress. */
  fetchedAt: number
  /** Resolved spotifyd device id (one-tap playback target), or null if absent. */
  spotifydDeviceId: string | null
  /** All currently-available Connect devices. */
  devices: SpotifyDevice[]
  /**
   * Actions the active device forbids (Spotify `actions.disallows`). spotifyd /
   * librespot disallows `toggling_shuffle` + `toggling_repeat_*`, so the UI can
   * disable those controls instead of firing doomed 403s.
   */
  disallows: string[]
}

export const EMPTY_SNAPSHOT: SpotifyPlayerSnapshot = {
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

export interface SpotifyStatus {
  hasCredentials: boolean
  connected: boolean
  userId?: string
  displayName?: string
  spotifydDeviceId: string | null
  spotifydOnline: boolean
}

// --- Light-weight search/library result shapes (mapped from Web API) ---

export interface SpotifyTrackLite {
  id: string | null
  uri: string
  name: string
  artists: string
  album: string
  albumArt: string | null
  durationMs: number
}

export interface SpotifyAlbumLite {
  id: string | null
  uri: string | null
  name: string
  artists: string
  albumArt: string | null
}

export interface SpotifyArtistLite {
  id: string | null
  uri: string
  name: string
  image: string | null
}

export interface SpotifyPlaylistLite {
  id: string
  uri: string
  name: string
  owner: string
  trackCount: number
  image: string | null
}

export interface SpotifySearchResults {
  tracks: SpotifyTrackLite[]
  albums: SpotifyAlbumLite[]
  artists: SpotifyArtistLite[]
  playlists: SpotifyPlaylistLite[]
}
