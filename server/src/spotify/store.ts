// Spotify now-playing snapshot store — hub-owned, broadcast over SyncBus.
// Tiny payload, so every change broadcasts the full snapshot (SnapshotStore
// default). Persisted to disk so a hub restart shows last-known until the first
// poll lands.

import { SnapshotStore } from '../snapshot-store.js'
import type { SyncBus } from '../sync-bus.js'
import { EMPTY_SNAPSHOT, type SpotifyPlayerSnapshot } from './types.js'

export class SpotifyStore {
  private store: SnapshotStore<SpotifyPlayerSnapshot>

  constructor(opts: { path: string; bus?: SyncBus; log?: (msg: string) => void }) {
    this.store = new SnapshotStore<SpotifyPlayerSnapshot>({
      name: 'spotify',
      path: opts.path,
      defaultValue: EMPTY_SNAPSHOT,
      bus: opts.bus,
      log: opts.log,
    })
  }

  snapshot() {
    return this.store.get()
  }

  current(): SpotifyPlayerSnapshot {
    return this.store.get().data
  }

  set(next: SpotifyPlayerSnapshot): void {
    this.store.update(() => next)
  }
}
