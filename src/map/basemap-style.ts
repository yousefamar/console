// On-demand vector basemap from OpenFreeMap (tiles.openfreemap.org) — keyless,
// explicit no-limits policy, nothing to host. CARTO's raster CDN was dropped
// (^zany-koi): its basemaps now require an API key (watermarked otherwise).
// These are FULL style URLs (sources + glyphs + sprite included) — MapLibre
// loads them directly, and every `style.load` (initial or a theme swap via
// map.setStyle) re-attaches our overlay layers in MapTab. Offline you get no
// streets, but overlays still render (data is offline-first via Dexie — the
// basemap is just a backdrop).

/** Positron in light mode, OFM's dark style otherwise (Yousef's call). */
export function basemapStyleUrl(dark: boolean): string {
  return dark
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/positron'
}
