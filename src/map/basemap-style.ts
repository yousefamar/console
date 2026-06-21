// On-demand dark basemap. Raster tiles streamed per-viewport from CARTO's free
// keyless basemap CDN — we host and generate nothing. MapLibre fetches only the
// visible tiles as you pan/zoom; the browser HTTP-caches revisits. Offline you
// get no streets, but your location track + cache pins still render (the data is
// offline-first via Dexie — the basemap is just a backdrop).

import type { StyleSpecification } from 'maplibre-gl'

const CARTO_DARK = ['a', 'b', 'c', 'd'].map(
  (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{ratio}.png`,
)

export function darkRasterStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      carto: {
        type: 'raster',
        tiles: CARTO_DARK.map((u) => u.replace('{ratio}', devicePixelRatio > 1 ? '@2x' : '')),
        tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0a0a0a' } },
      { id: 'carto', type: 'raster', source: 'carto' },
    ],
  }
}
