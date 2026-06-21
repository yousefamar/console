// MapLibre basemap wiring: the Protomaps PMTiles protocol + a dark vector style.
//
// Online, MapLibre streams byte ranges from the hub's range-capable
// /public/basemap/<region>.pmtiles route. Offline, a downloaded archive is
// served from an IndexedDB Blob via a registered PMTiles instance (see
// registerOfflineArchive) — no service worker, no network. The dark theme comes
// from protomaps-themes-base, so it tracks the basemap schema automatically.

import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import { Protocol, PMTiles, FileSource } from 'pmtiles'
import { layers, namedTheme } from 'protomaps-themes-base'
import { getHubUrl } from '@/hub'

const ASSETS = 'https://protomaps.github.io/basemaps-assets'
let protocol: Protocol | null = null

/** Register the `pmtiles://` protocol once for the whole app. */
export function ensurePmtilesProtocol(): Protocol {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
  return protocol
}

/** Public, auth-exempt URL of a hub-served basemap archive. */
export function basemapUrl(region: string): string {
  const origin = new URL(getHubUrl()).origin
  return `${origin}/public/basemap/${region}.pmtiles`
}

/**
 * Register a downloaded archive (Blob from IndexedDB) under a `pmtiles://<key>`
 * URL so MapLibre reads tiles straight from local bytes — fully offline.
 */
export function registerOfflineArchive(key: string, blob: Blob): string {
  const p = ensurePmtilesProtocol()
  // FileSource slices the blob; a Blob satisfies the same interface as a File.
  const archive = new PMTiles(new FileSource(blob as File))
  p.add(archive)
  return `pmtiles://${key}`
}

/** Build the dark vector style pointed at `sourceUrl` (an http(s) or pmtiles:// URL). */
export function darkStyle(sourceUrl: string): StyleSpecification {
  const url = sourceUrl.startsWith('pmtiles://') ? sourceUrl : `pmtiles://${sourceUrl}`
  return {
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/dark`,
    sources: {
      protomaps: { type: 'vector', url },
    },
    layers: layers('protomaps', namedTheme('dark')) as StyleSpecification['layers'],
  }
}
