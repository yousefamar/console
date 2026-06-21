// Offline basemap storage. The hub serves a region's .pmtiles via HTTP Range;
// "Make available offline" downloads the whole archive into IndexedDB (Dexie) as
// a Blob. A custom PMTiles source then reads byte ranges straight from the Blob —
// fully offline, independent of the (PROD-only, 206-incompatible) service worker.

import { db } from '@/db'
import type { StyleSpecification } from 'maplibre-gl'
import { basemapUrl, registerOfflineArchive, darkStyle } from './pmtiles-source'

export async function getOfflineBlob(region: string): Promise<Blob | null> {
  const row = await db.basemaps.get(region)
  return row?.blob ?? null
}

export async function isRegionOffline(region: string): Promise<boolean> {
  return (await db.basemaps.where('region').equals(region).count()) > 0
}

export async function listOfflineRegions(): Promise<Array<{ region: string; bytes: number; downloadedAt: number }>> {
  return (await db.basemaps.toArray()).map(({ region, bytes, downloadedAt }) => ({ region, bytes, downloadedAt }))
}

export async function deleteRegion(region: string): Promise<void> {
  await db.basemaps.delete(region)
}

/** Download a region's archive into IndexedDB, reporting progress (0..1). */
export async function downloadRegion(region: string, onProgress?: (frac: number) => void): Promise<void> {
  const res = await fetch(basemapUrl(region))
  if (!res.ok) throw new Error(`basemap "${region}" not available on the hub (HTTP ${res.status}). Run \`con basemap update\`.`)
  const total = Number(res.headers.get('content-length') || 0)

  let blob: Blob
  const reader = res.body?.getReader()
  if (reader && total > 0) {
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      onProgress?.(loaded / total)
    }
    blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' })
  } else {
    blob = await res.blob()
    onProgress?.(1)
  }

  await db.basemaps.put({ region, blob, bytes: blob.size, downloadedAt: Date.now() })
}

/** Style for a region: offline Blob if downloaded, else stream from the hub. */
export async function styleForRegion(region: string): Promise<StyleSpecification> {
  const blob = await getOfflineBlob(region)
  if (blob) return darkStyle(registerOfflineArchive(`offline-${region}`, blob))
  return darkStyle(basemapUrl(region))
}
