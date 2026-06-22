// Spotify player poller.
//
// Spotify gives no realtime push, so we poll GET /me/player. To avoid hammering
// the API 24/7 we only poll while at least one client is subscribed to the
// `spotify` SyncBus service (i.e. a music drawer is open somewhere). A control
// action calls `pokeSoon()` to fetch fresh state shortly after, regardless of
// subscribers, so the UI converges fast.
//
// We only push a new snapshot when something *significant* changes (track,
// play state, device, volume, shuffle/repeat, or a progress jump that implies a
// seek). Smooth progress between snapshots is interpolated client-side from
// `fetchedAt` + `progressMs`, so steady playback needs zero broadcasts.

import type { SyncBus } from '../sync-bus.js'
import type { SpotifyClient } from './client.js'
import type { SpotifyStore } from './store.js'
import type { SpotifyPlayerSnapshot } from './types.js'

export class SpotifyPlayerSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private pokeTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private last: SpotifyPlayerSnapshot | null = null
  private readonly INTERVAL_MS = 3000

  constructor(
    private client: SpotifyClient,
    private store: SpotifyStore,
    private bus: SyncBus,
    private log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.log('[spotify-sync] starting (polls only while a drawer is open)')
    this.timer = setInterval(() => {
      if (this.bus.subscriberCount('spotify') > 0) {
        this.tick(false).catch((e) => this.log(`[spotify-sync] tick failed: ${(e as Error).message}`))
      }
    }, this.INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
    this.pokeTimer = null
  }

  /** Force a fresh fetch + broadcast and return the snapshot (RPC/HTTP refresh). */
  async syncNow(): Promise<SpotifyPlayerSnapshot> {
    await this.tick(true)
    return this.store.current()
  }

  /** After a control action, fetch fresh state soon (coalesced). */
  pokeSoon(delayMs = 700): void {
    if (this.pokeTimer) return
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      this.tick(true).catch((e) => this.log(`[spotify-sync] poke failed: ${(e as Error).message}`))
    }, delayMs)
  }

  private async tick(force: boolean): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const snap = await this.client.getPlayer()
      if (force || significantlyDiffers(this.last, snap)) {
        this.store.set(snap)
        this.last = snap
      }
    } finally {
      this.running = false
    }
  }
}

/** Whether two snapshots differ enough to warrant a broadcast. */
function significantlyDiffers(a: SpotifyPlayerSnapshot | null, b: SpotifyPlayerSnapshot): boolean {
  if (!a) return true
  if (a.linked !== b.linked) return true
  if (a.isPlaying !== b.isPlaying) return true
  if (a.shuffle !== b.shuffle) return true
  if (a.repeat !== b.repeat) return true
  if ((a.item?.uri ?? null) !== (b.item?.uri ?? null)) return true
  if ((a.device?.id ?? null) !== (b.device?.id ?? null)) return true
  if ((a.device?.volumePercent ?? null) !== (b.device?.volumePercent ?? null)) return true
  if ((a.spotifydDeviceId ?? null) !== (b.spotifydDeviceId ?? null)) return true
  if (a.devices.length !== b.devices.length) return true
  // Progress jump beyond what elapsed wall-clock explains → a seek happened.
  const elapsed = b.fetchedAt - a.fetchedAt
  const expected = a.progressMs + (a.isPlaying ? elapsed : 0)
  if (Math.abs(b.progressMs - expected) > 4000) return true
  return false
}
