// Agent map-layers subscriber. The hub broadcasts only the lightweight INDEX
// over SyncBus; we fetch each layer's GeoJSON over HTTP (layers can be multi-MB)
// and cache it in Dexie for offline rendering. Mirrors the geocaching subscriber.

import { db, getMeta, setMeta } from '@/db'
import { hubBus } from '@/sync-bus'
import { hubFetch } from '@/hub'
import { useMapStore, type MapLayerMeta } from '@/store/map'

const INDEX_KEY = 'console:mapLayerIndex:v1'

async function syncLayerData(meta: MapLayerMeta): Promise<void> {
  try {
    const cached = await db.mapLayers.get(meta.slug)
    if (cached && cached.updatedAt === meta.updatedAt) {
      useMapStore.getState().setLayerData(meta.slug, cached.geojson)
      return
    }
    const gj = await hubFetch<unknown>(`/map/layers/${meta.slug}`)
    await db.mapLayers.put({ slug: meta.slug, updatedAt: meta.updatedAt, geojson: gj }).catch(() => {})
    useMapStore.getState().setLayerData(meta.slug, gj)
  } catch {
    // offline / deleted — keep whatever we have
  }
}

async function applyIndex(metas: MapLayerMeta[]): Promise<void> {
  useMapStore.getState().setLayers(metas)
  await setMeta(INDEX_KEY, JSON.stringify(metas)).catch(() => {})
  const slugs = new Set(metas.map((m) => m.slug))
  const local = (await db.mapLayers.toCollection().primaryKeys()) as string[]
  const stale = local.filter((s) => !slugs.has(s))
  if (stale.length) await db.mapLayers.bulkDelete(stale).catch(() => {})
  for (const m of metas) void syncLayerData(m)
}

async function hydrateFromDb(): Promise<void> {
  try {
    const raw = await getMeta(INDEX_KEY)
    if (!raw) return
    const metas = JSON.parse(raw) as MapLayerMeta[]
    useMapStore.getState().setLayers(metas)
    for (const m of metas) {
      const c = await db.mapLayers.get(m.slug)
      if (c) useMapStore.getState().setLayerData(m.slug, c.geojson)
    }
  } catch {
    // no cache yet
  }
}

async function fetchSnapshot(): Promise<void> {
  const env = await hubBus.rpc<{ layers: MapLayerMeta[] }>('map-layers', 'snapshot', undefined)
  if (env?.layers) await applyIndex(env.layers)
}

/** Idempotent; call once on boot. */
export function wireMapLayersSubscription(): () => void {
  void hydrateFromDb()
  const unsubDelta = hubBus.on('map-layers', 'delta', (d) => void applyIndex((d as { layers: MapLayerMeta[] }).layers))
  const unsubConnect = hubBus.onConnect(() => { void fetchSnapshot().catch(() => {}) })
  return () => {
    unsubDelta()
    unsubConnect()
  }
}
