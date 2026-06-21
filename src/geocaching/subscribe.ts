// Hub geocaching subscriber — mirrors the hub-authoritative geocache store into
// the client's Dexie cache + the map store. Gives offline rendering and live
// cross-device updates (a fetch-area on PC shows up on the phone's map).
//
// Wire shape matches server/src/index.ts's `geocaching` SyncBus service:
//   snapshot RPC → { caches: Geocache[] }   (summaries only)
//   `delta` broadcast → { caches: Geocache[] } (the rows that just changed)

import { db, type DbGeocache } from '@/db'
import { hubBus } from '@/sync-bus'
import { useMapStore, type MapCache } from '@/store/map'

interface GeocachingEnvelope {
  caches: MapCache[]
}

function toDb(c: MapCache): DbGeocache {
  const { detail: _detail, ...summary } = c
  return summary
}

function apply(caches: MapCache[] | undefined): void {
  if (!caches?.length) return
  void db.geocaches.bulkPut(caches.map(toDb)).catch(() => {})
  useMapStore.getState().mergePins(caches)
}

async function hydrateFromDb(): Promise<void> {
  try {
    const rows = await db.geocaches.toArray()
    if (rows.length) useMapStore.getState().mergePins(rows as MapCache[])
  } catch {
    // empty / unavailable — fine
  }
}

async function fetchSnapshot(): Promise<void> {
  const env = await hubBus.rpc<GeocachingEnvelope>('geocaching', 'snapshot', undefined)
  apply(env?.caches)
}

/** Idempotent; call once on boot. Returns an unsubscribe function. */
export function wireGeocachingSubscription(): () => void {
  void hydrateFromDb()
  const unsubDelta = hubBus.on('geocaching', 'delta', (data) => apply((data as GeocachingEnvelope).caches))
  const unsubConnect = hubBus.onConnect(() => { void fetchSnapshot().catch(() => {}) })
  return () => {
    unsubDelta()
    unsubConnect()
  }
}
