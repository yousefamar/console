// Live now-playing subscription for the music drawer.
//
// Deliberately NOT wired at app boot: we only subscribe to the `spotify`
// SyncBus service while the drawer is open, which is exactly what gates the
// hub-side poller (it polls only while subscriberCount('spotify') > 0). So
// closing the drawer stops the polling.
//
// Wire shape (server/src/index.ts `spotify` service + SnapshotStore):
//   `delta` broadcast → { seq, data: MusicSnapshot }
//   initial load is plain HTTP GET /spotify/player (forces a fresh poll),
//   matching the "use HTTP for initial load" convention.

import { hubBus } from '@/sync-bus'
import { useMusicStore, type MusicSnapshot } from '@/store/music'

interface DeltaEnvelope {
  seq: number
  data: MusicSnapshot
}

/** Subscribe to live now-playing updates. Returns an unsubscribe fn. */
export function subscribeMusicLive(): () => void {
  // Initial fresh load over HTTP (also wakes the hub poller via the sub below).
  void useMusicStore.getState().refresh()

  const unsubDelta = hubBus.on('spotify', 'delta', (data) => {
    const env = data as DeltaEnvelope
    if (env?.data) useMusicStore.getState().setSnapshot(env.data)
  })
  const unsubConnect = hubBus.onConnect(() => {
    void useMusicStore.getState().refresh()
  })

  return () => {
    unsubDelta()
    unsubConnect()
  }
}
