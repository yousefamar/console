// Global right-side music drawer. Mounted only while open (Layout renders it
// conditionally), so its live subscription — and therefore the hub poller —
// only runs while the drawer is visible. Playback control also happens via
// system media keys (Sway → `con music …`); this is the visual + mouse surface.

import { useEffect, useRef, useState } from 'react'
import {
  X, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  Volume2, Search, Music, ListPlus, Cast, Heart, Plus,
} from 'lucide-react'
import { getHubUrl } from '@/hub'
import { useMusicStore } from '@/store/music'
import { subscribeMusicLive } from '@/music/live'

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function MusicDrawer({ onClose }: { onClose: () => void }) {
  const snap = useMusicStore((s) => s.snapshot)
  const store = useMusicStore()
  const [, setTick] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  // Live now-playing while open (drives the hub poller via subscription).
  useEffect(() => subscribeMusicLive(), [])

  // Esc closes the drawer (capture-phase so it wins before other handlers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 1s ticker to interpolate progress smoothly between snapshots.
  useEffect(() => {
    if (!snap?.isPlaying) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [snap?.isPlaying])

  useEffect(() => { searchRef.current?.focus() }, [])

  // Load playlists once; re-check "liked" whenever the track changes.
  useEffect(() => { void useMusicStore.getState().loadPlaylists() }, [])
  useEffect(() => { void useMusicStore.getState().checkLiked() }, [snap?.item?.id])

  const item = snap?.item
  const elapsed = snap ? snap.progressMs + (snap.isPlaying ? Date.now() - snap.fetchedAt : 0) : 0
  const progress = item ? Math.min(item.durationMs, Math.max(0, elapsed)) : 0
  const pct = item && item.durationMs ? (progress / item.durationMs) * 100 : 0

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!item) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    void store.seek(frac * item.durationMs)
  }

  const onSpotifyd = snap?.device?.id && snap.spotifydDeviceId && snap.device.id !== snap.spotifydDeviceId
  // spotifyd/librespot forbids shuffle + repeat over Connect — disable rather than fire doomed 403s.
  const noShuffle = snap?.disallows?.includes('toggling_shuffle') ?? false
  const noRepeat = (snap?.disallows?.includes('toggling_repeat_context') && snap?.disallows?.includes('toggling_repeat_track')) ?? false

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-80 max-w-full flex-col border-l border-border bg-surface-1 shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-medium text-text-primary">
          <Music size={14} /> Music
        </span>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors" title="Close (Esc)">
          <X size={14} />
        </button>
      </div>

      {!snap?.linked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Music size={28} className="text-text-tertiary" />
          <p className="text-xs text-text-tertiary">Spotify isn’t linked yet.</p>
          <a
            href={`${getHubUrl()}/auth/spotify/start`}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Connect Spotify
          </a>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {snap.devices.length === 0 && (
            <div className="mx-3 mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-500">
              No playback device. Open Spotify on a device, pick <span className="font-medium">amarhp-spotifyd</span> in the Connect menu and press play, then try again.
            </div>
          )}
          {/* Now playing */}
          <div className="flex flex-col items-center gap-3 px-4 pt-4">
            <div className="aspect-square w-44 overflow-hidden rounded bg-surface-2">
              {item?.albumArt ? (
                <img src={item.albumArt} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                  <Music size={36} />
                </div>
              )}
            </div>
            <div className="flex w-full items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary" title={item?.name}>
                  {item?.name ?? 'Nothing playing'}
                </div>
                <div className="truncate text-xs text-text-tertiary" title={item?.artists}>
                  {item?.artists ?? ''}
                </div>
              </div>
              <button
                onClick={() => void store.toggleLike()}
                disabled={!item}
                className={`shrink-0 transition-colors disabled:opacity-30 ${store.currentLiked ? 'text-accent' : 'text-text-tertiary hover:text-text-primary'}`}
                title={store.currentLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
              >
                <Heart size={18} fill={store.currentLiked ? 'currentColor' : 'none'} />
              </button>
            </div>
          </div>

          {/* Progress */}
          <div className="px-4 pt-3">
            <div className="h-1.5 w-full cursor-pointer rounded-full bg-surface-3" onClick={onScrub}>
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-text-tertiary">
              <span>{fmt(progress)}</span>
              <span>{item ? fmt(item.durationMs) : '0:00'}</span>
            </div>
          </div>

          {/* Transport */}
          <div className="flex items-center justify-center gap-4 px-4 py-3">
            <button
              onClick={() => !noShuffle && void store.toggleShuffle()}
              disabled={noShuffle}
              className={`transition-colors ${noShuffle ? 'cursor-not-allowed text-text-tertiary/40' : snap.shuffle ? 'text-accent' : 'text-text-tertiary hover:text-text-primary'}`}
              title={noShuffle ? 'Shuffle not supported by this device' : 'Shuffle'}
            >
              <Shuffle size={16} />
            </button>
            <button onClick={() => void store.previous()} className="text-text-secondary hover:text-text-primary" title="Previous">
              <SkipBack size={20} />
            </button>
            <button
              onClick={() => void store.togglePlay()}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white hover:opacity-90"
              title="Play / pause"
            >
              {snap.isPlaying ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
            </button>
            <button onClick={() => void store.next()} className="text-text-secondary hover:text-text-primary" title="Next">
              <SkipForward size={20} />
            </button>
            <button
              onClick={() => !noRepeat && void store.cycleRepeat()}
              disabled={noRepeat}
              className={`transition-colors ${noRepeat ? 'cursor-not-allowed text-text-tertiary/40' : snap.repeat !== 'off' ? 'text-accent' : 'text-text-tertiary hover:text-text-primary'}`}
              title={noRepeat ? 'Repeat not supported by this device' : `Repeat: ${snap.repeat}`}
            >
              {snap.repeat === 'track' ? <Repeat1 size={16} /> : <Repeat size={16} />}
            </button>
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2 px-4 pb-2">
            <Volume2 size={14} className="text-text-tertiary" />
            <input
              type="range"
              min={0}
              max={100}
              value={snap.device?.volumePercent ?? 0}
              onChange={(e) => void store.setVolume(Number(e.target.value))}
              className="h-1 w-full accent-accent"
            />
          </div>

          {/* Device */}
          <div className="flex items-center gap-2 px-4 pb-3 text-[11px] text-text-tertiary">
            <Cast size={12} />
            <span className="truncate">{snap.device?.name ?? 'No active device'}</span>
            {onSpotifyd && (
              <button
                onClick={() => snap.spotifydDeviceId && void store.transfer(snap.spotifydDeviceId)}
                className="ml-auto rounded border border-border px-1.5 py-0.5 hover:text-text-primary"
                title="Move playback to spotifyd"
              >
                → spotifyd
              </button>
            )}
          </div>

          {/* Search */}
          <div className="border-t border-border px-3 py-2">
            <div className="flex items-center gap-2 rounded bg-surface-2 px-2 py-1">
              <Search size={13} className="text-text-tertiary" />
              <input
                ref={searchRef}
                value={store.searchQuery}
                onChange={(e) => void store.search(e.target.value)}
                placeholder="Search & play…"
                className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </div>
            <div className="mt-1">
              {store.searchResults.map((t) => (
                <div
                  key={t.uri}
                  className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
                >
                  <button
                    onClick={() => void store.playUri(t.uri)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title="Play"
                  >
                    {t.albumArt ? (
                      <img src={t.albumArt} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-surface-3 text-text-tertiary">
                        <Music size={12} />
                      </div>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-text-primary">{t.name}</span>
                      <span className="block truncate text-[10px] text-text-tertiary">{t.artists}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => void store.queueUri(t.uri)}
                    className="shrink-0 text-text-tertiary opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                    title="Add to queue"
                  >
                    <ListPlus size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Library — Liked Songs + playlists. Click a row to play; + adds the current track */}
          <div className="border-t border-border px-3 py-2">
            <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
              Library
            </div>
            <button
              onClick={() => void store.playLiked()}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2"
              title="Play Liked Songs"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gradient-to-br from-accent to-accent/40 text-white">
                <Heart size={14} fill="currentColor" />
              </div>
              <span className="block truncate text-xs font-medium text-text-primary">Liked Songs</span>
            </button>
            {store.playlists.length > 0 && (
              <div className="px-1 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                Playlists
              </div>
            )}
            {store.playlists.map((p) => (
                <div key={p.id} className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2">
                  <button
                    onClick={() => void store.playUri(p.uri)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title="Play playlist"
                  >
                    {p.image ? (
                      <img src={p.image} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-surface-3 text-text-tertiary">
                        <Music size={12} />
                      </div>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-text-primary">{p.name}</span>
                      <span className="block truncate text-[10px] text-text-tertiary">{p.trackCount} tracks</span>
                    </span>
                  </button>
                  <button
                    onClick={() => item && void store.addCurrentToPlaylist(p.id)}
                    disabled={!item}
                    className="shrink-0 text-text-tertiary opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100 disabled:opacity-0"
                    title="Add current track to this playlist"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
