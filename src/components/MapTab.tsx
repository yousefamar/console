import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './map-popup.css'
import type { FeatureCollection } from 'geojson'
import { Crosshair, Download, MapPin, X, KeyRound, Loader2, Layers as LayersIcon } from 'lucide-react'
import { useMapStore, type MapCache, type OtFix, type MapLayerMeta, type MapLayerStyle } from '@/store/map'
import type { FeatureCollection as GJ } from 'geojson'
import { darkRasterStyle } from '@/map/basemap-style'
import { mapController } from '@/map/controller'

/** Colour a log entry by its type — same family as the pins, so the detail panel
 *  reads at a glance: green found, red DNF, amber maintenance, slate the rest. */
function logColor(type: string): string {
  switch (type) {
    case 'found_it':
    case 'attended':
    case 'webcam_photo_taken': return '#22c55e'
    case 'didnt_find_it': return '#ef4444'
    case 'needs_maintenance':
    case 'needs_archive':
    case 'owner_maintenance': return '#f59e0b'
    default: return '#94a3b8'
  }
}

/** Strip HTML from gc.com log text (logs come back as `<p>…</p>` fragments). */
function stripHtml(s: string): string {
  if (!s) return ''
  const pre = s.replace(/<\/(p|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
  const text = new DOMParser().parseFromString(pre, 'text/html').body.textContent ?? ''
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

// Geocache pins are emoji glyphs (geocaching.com mental model): your find-state
// wins — 😀 found, 😟 DNF — otherwise the cache TYPE emoji for not-yet-attempted.
const TYPE_EMOJI: unknown[] = [
  'match', ['get', 'type'],
  'Traditional', '📦',
  'Multi-cache', '🧩',
  'Mystery', '❓',
  'Letterbox', '✉️',
  'EarthCache', '🌍',
  'Event', '🎉',
  'Mega-Event', '🎉',
  'Giga-Event', '🎉',
  'Community Celebration', '🎉',
  'HQ Block Party', '🎉',
  'HQ Celebration', '🎉',
  'Cache In Trash Out Event', '♻️',
  'Webcam', '📷',
  'Virtual', '🔮',
  'Wherigo', '🕹️',
  'GPS Adventures Exhibit', '🧭',
  'Geocaching HQ', '🏢',
  'Locationless', '🌐',
  'Project APE', '🦍',
  /* default */ '📍',
]
const PIN_EMOJI: unknown[] = [
  'case',
  ['==', ['get', 'found'], 1], '😀',
  ['==', ['get', 'dnf'], 1], '😟',
  TYPE_EMOJI,
]

function pinsToFC(pins: MapCache[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pins
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon as number, p.lat as number] },
        properties: { code: p.code, type: p.type, found: p.found ? 1 : 0, dnf: p.dnf ? 1 : 0 },
      })),
  }
}

function trackToFC(track: OtFix[]): FeatureCollection {
  const coords = track.map((f) => [f.lon, f.lat])
  return {
    type: 'FeatureCollection',
    features: coords.length >= 2 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] : [],
  }
}

function currentToFC(current: OtFix[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: current
      .filter((f) => typeof f.lat === 'number')
      .map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        properties: { device: f.device ?? '' },
      })),
  }
}

function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function MapTab() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const readyRef = useRef(false)
  const centeredRef = useRef(false)

  const {
    current, track, pins, selectedCode, gcStatus, fetching, error,
    rangeFrom, rangeTo, device, devices, loadingHistory,
    refresh, loadHistory, selectCache, loadLayers,
    layers, layerData, layerVisible,
  } = useMapStore()

  const [showCreds, setShowCreds] = useState(false)
  const [showLayers, setShowLayers] = useState(false)
  const fittedRef = useRef<Set<string>>(new Set())

  // --- init map (once) ------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: darkRasterStyle(),
      center: [-2, 54],
      zoom: 5,
      attributionControl: false,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', () => {/* tolerate the odd tile 404 — non-fatal */})
    registerEmojiImages(map)

    // Add overlay layers once the style is ready (fires on initial load).
    map.on('style.load', () => {
      const m = mapRef.current
      if (!m) return
      addOverlayLayers(m)
      readyRef.current = true
      const st = useMapStore.getState()
      pushSource(m, 'gc-pins', pinsToFC(st.pins))
      pushSource(m, 'ot-track', trackToFC(st.track))
      pushSource(m, 'ot-current', currentToFC(st.current))
      reconcileAgentLayers(m, st.layers, st.layerData, st.layerVisible)
    })

    // Layer-scoped handlers bind once (deferred by layer id is fine in MapLibre).
    map.on('click', 'gc-pins', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined
      if (code) void selectCache(code)
    })
    map.on('mouseenter', 'gc-pins', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'gc-pins', () => { map.getCanvas().style.cursor = '' })

    mapController.flyToMe = () => {
      const c = useMapStore.getState().current[0]
      if (c) map.flyTo({ center: [c.lon, c.lat], zoom: 14 })
    }
    mapController.fetchHere = () => {
      const b = map.getBounds()
      void useMapStore.getState().fetchArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]).catch(() => {})
    }

    return () => {
      mapController.flyToMe = undefined
      mapController.fetchHere = undefined
      map.remove()
      mapRef.current = null
      readyRef.current = false
    }
  }, [selectCache])

  // initial data load
  useEffect(() => {
    void refresh().then(() => void loadHistory())
    void loadLayers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // push store slices → map sources
  useEffect(() => { if (readyRef.current && mapRef.current) pushSource(mapRef.current, 'gc-pins', pinsToFC(pins)) }, [pins])
  useEffect(() => { if (readyRef.current && mapRef.current) pushSource(mapRef.current, 'ot-track', trackToFC(track)) }, [track])
  useEffect(() => {
    if (readyRef.current && mapRef.current) pushSource(mapRef.current, 'ot-current', currentToFC(current))
    if (!centeredRef.current && current[0] && mapRef.current) {
      centeredRef.current = true
      mapRef.current.flyTo({ center: [current[0].lon, current[0].lat], zoom: 11 })
    }
  }, [current])
  useEffect(() => {
    const map = mapRef.current
    if (readyRef.current && map) map.setFilter('gc-selected', ['==', ['get', 'code'], selectedCode ?? ''])
  }, [selectedCode])

  // agent-authored layers → reconcile sources/layers + fit-to-bounds once
  useEffect(() => {
    const map = mapRef.current
    if (!readyRef.current || !map) return
    reconcileAgentLayers(map, layers, layerData, layerVisible)
    for (const l of layers) {
      if (l.fit && l.bbox && layerData[l.slug] && layerVisible[l.slug] !== false && !fittedRef.current.has(l.slug)) {
        fittedRef.current.add(l.slug)
        const [w, s, e, n] = l.bbox
        map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 600 })
      }
    }
  }, [layers, layerData, layerVisible])

  const selected = pins.find((p) => p.code === selectedCode) ?? null
  const budget = gcStatus?.budget

  return (
    <div className="relative flex flex-1 min-h-0">
      <div ref={containerRef} className="flex-1 min-h-0" />

      {/* top toolbar */}
      <div className="absolute top-2 left-2 right-14 flex flex-wrap items-center gap-2 text-xs">
        <div className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur">
          <input
            type="date" value={ymd(rangeFrom)}
            onChange={(e) => e.target.value && void loadHistory(new Date(e.target.value).getTime(), rangeTo)}
            className="bg-transparent outline-none w-[7.5rem]"
          />
          <span className="text-text-tertiary">→</span>
          <input
            type="date" value={ymd(rangeTo)}
            onChange={(e) => e.target.value && void loadHistory(rangeFrom, new Date(e.target.value).getTime())}
            className="bg-transparent outline-none w-[7.5rem]"
          />
          {devices.length > 1 && (
            <select
              value={device ?? ''} onChange={(e) => void loadHistory(undefined, undefined, e.target.value)}
              className="bg-transparent outline-none"
            >
              {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <button onClick={() => void loadHistory()} className="ml-1 px-1.5 py-0.5 rounded bg-surface-2 hover:bg-surface-3">
            {loadingHistory ? <Loader2 size={12} className="animate-spin" /> : 'History'}
          </button>
          {([['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365]] as const).map(([lbl, n]) => (
            <button
              key={lbl}
              onClick={() => void loadHistory(Date.now() - n * 86400000, Date.now())}
              className="px-1 py-0.5 rounded hover:bg-surface-2 text-text-tertiary"
            >
              {lbl}
            </button>
          ))}
        </div>

        <button
          onClick={() => mapController.fetchHere?.()}
          disabled={fetching || !gcStatus?.loggedIn}
          title={gcStatus?.loggedIn ? 'Fetch geocaches in the current view' : 'Set geocaching.com credentials first'}
          className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur hover:bg-surface-2 disabled:opacity-50"
        >
          {fetching ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Fetch here
        </button>

        <button
          onClick={() => mapController.flyToMe?.()}
          title="Centre on my location"
          className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur hover:bg-surface-2"
        >
          <Crosshair size={12} /> Me
        </button>

        <button
          onClick={() => setShowCreds((v) => !v)}
          className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur hover:bg-surface-2"
        >
          <KeyRound size={12} />
          {gcStatus?.loggedIn ? gcStatus.username : 'Sign in'}
        </button>

        <button
          onClick={() => setShowLayers((v) => !v)}
          title="Toggle map layers"
          className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur hover:bg-surface-2"
        >
          <LayersIcon size={12} /> Layers{layers.length ? ` (${layers.length})` : ''}
        </button>

        {budget && (
          <span className="rounded bg-surface-0/90 border border-border px-2 py-1 text-text-tertiary backdrop-blur">
            {budget.remaining}/{budget.cap} left · {pins.length} caches
          </span>
        )}
        {error && <span className="rounded bg-red-500/20 text-red-300 border border-red-500/40 px-2 py-1">{error}</span>}
      </div>

      {/* legend — pins are emoji: find-state, else cache type */}
      <div className="absolute bottom-2 left-2 flex items-center gap-3 rounded bg-surface-0/90 border border-border px-2 py-1 text-[11px] text-text-secondary backdrop-blur">
        <span>😀 found</span>
        <span>😟 DNF</span>
        <span>📦❓🧩🌍 type = to-do</span>
      </div>

      {showCreds && <CredentialsPanel onClose={() => setShowCreds(false)} />}
      {showLayers && <LayersPanel onClose={() => setShowLayers(false)} />}
      {selected && <CacheDetailPanel cache={selected} onClose={() => void selectCache(null)} />}
    </div>
  )
}

// MapLibre renders emoji in a text-field as monochrome SDF glyphs (black). To
// get COLOUR emoji we rasterise each one to a canvas (system colour-emoji font)
// and register it as a map image, referenced via icon-image `em:<emoji>`.
// A `styleimagemissing` handler generates them on demand — so any emoji (fixed
// geocache set OR an agent layer's arbitrary `_icon`) just works.
function emojiImage(emoji: string, px = 44): ImageData | null {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, px, px)
  ctx.font = `${Math.round(px * 0.8)}px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(emoji, px / 2, px / 2 + Math.round(px * 0.04))
  return ctx.getImageData(0, 0, px, px)
}

function registerEmojiImages(map: maplibregl.Map) {
  map.on('styleimagemissing', (e: { id: string }) => {
    const id = e.id
    if (!id.startsWith('em:') || map.hasImage(id)) return
    const img = emojiImage(id.slice(3))
    if (img && !map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 })
  })
}

function pushSource(map: maplibregl.Map, id: string, data: FeatureCollection) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  if (src) src.setData(data)
}

/** Idempotently (re)add the OwnTracks + geocache overlay sources/layers. */
function addOverlayLayers(map: maplibregl.Map) {
  if (!map.getSource('ot-track')) {
    map.addSource('ot-track', { type: 'geojson', data: trackToFC([]) })
    map.addLayer({ id: 'ot-track', type: 'line', source: 'ot-track', paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-opacity': 0.8 } })
  }
  if (!map.getSource('gc-pins')) {
    map.addSource('gc-pins', { type: 'geojson', data: pinsToFC([]) })
    // Selection ring sits UNDER the emoji glyph (added first).
    map.addLayer({
      id: 'gc-selected', type: 'circle', source: 'gc-pins',
      filter: ['==', ['get', 'code'], ''],
      paint: { 'circle-radius': 14, 'circle-color': 'rgba(56,189,248,0.18)', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
    })
    map.addLayer({
      id: 'gc-pins', type: 'symbol', source: 'gc-pins',
      layout: {
        'icon-image': ['concat', 'em:', PIN_EMOJI] as unknown as maplibregl.ExpressionSpecification,
        'icon-size': 0.6,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
  }
  if (!map.getSource('ot-current')) {
    map.addSource('ot-current', { type: 'geojson', data: currentToFC([]) })
    map.addLayer({
      id: 'ot-current', type: 'circle', source: 'ot-current',
      paint: { 'circle-radius': 7, 'circle-color': '#3b82f6', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
    })
  }
}

// --- agent-authored layers ---------------------------------------------------

type Expr = maplibregl.ExpressionSpecification
const expr = (v: unknown) => v as unknown as Expr

function subIds(slug: string) {
  const b = `layer:${slug}`
  return { src: b, fill: `${b}:fill`, line: `${b}:line`, circle: `${b}:circle`, symbol: `${b}:symbol` }
}

function removeAgentLayer(map: maplibregl.Map, slug: string) {
  const { src, fill, line, circle, symbol } = subIds(slug)
  for (const id of [fill, line, circle, symbol]) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(src)) map.removeSource(src)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function buildPopupHtml(props: Record<string, unknown>, style: MapLayerStyle): string {
  const entries = style.popup?.length
    ? style.popup.map((f) => (typeof f === 'string' ? { key: f, label: f } : { key: f.key, label: f.label ?? f.key }))
    : Object.keys(props).filter((k) => !k.startsWith('_')).map((k) => ({ key: k, label: k }))
  // Lift name/_label to a bold title; the rest become aligned key→value rows.
  const name = props.name ?? props._label
  const rows = entries
    .filter((e) => e.key !== 'name' && props[e.key] != null && props[e.key] !== '')
    .map((e) => `<div class="pr"><span class="pk">${escapeHtml(e.label)}</span><span class="pv">${escapeHtml(String(props[e.key]))}</span></div>`)
    .join('')
  const title = name != null && name !== '' ? `<div class="pt">${escapeHtml(String(name))}</div>` : ''
  return title + rows // '' when the feature has nothing to show → no popup
}

function addOrUpdateAgentLayer(map: maplibregl.Map, meta: MapLayerMeta, data: GJ) {
  const { src, fill, line, circle, symbol } = subIds(meta.slug)
  const existing = map.getSource(src) as maplibregl.GeoJSONSource | undefined
  if (existing) { existing.setData(data); return }
  const st = meta.style || {}
  const before = map.getLayer('gc-pins') ? 'gc-pins' : undefined

  map.addSource(src, { type: 'geojson', data })
  map.addLayer({ id: fill, type: 'fill', source: src, paint: { 'fill-color': st.fillColor ?? '#3b82f6', 'fill-opacity': st.fillOpacity ?? 0.15 } }, before)
  map.addLayer({ id: line, type: 'line', source: src, paint: { 'line-color': expr(['coalesce', ['get', '_color'], st.strokeColor ?? st.lineColor ?? '#3b82f6']), 'line-width': st.strokeWidth ?? st.lineWidth ?? 1.5 } }, before)
  map.addLayer({
    id: circle, type: 'circle', source: src,
    // Point geometries only — without this guard MapLibre draws a circle at
    // every vertex of lines/polygons (blobs along an isochrone border).
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', '_icon']]] as maplibregl.FilterSpecification,
    paint: {
      'circle-color': expr(['coalesce', ['get', '_color'], st.color ?? '#22c55e']),
      'circle-radius': expr(['coalesce', ['get', '_size'], st.size ?? 5]),
      'circle-stroke-width': 1,
      'circle-stroke-color': '#0a0a0a',
    },
  }, before)
  map.addLayer({
    id: symbol, type: 'symbol', source: src,
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', '_icon']] as maplibregl.FilterSpecification,
    layout: {
      'icon-image': expr(['concat', 'em:', ['get', '_icon']]),
      'icon-size': 0.7,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  }, before)

  const onClick = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) return
    const html = buildPopupHtml((f.properties ?? {}) as Record<string, unknown>, st)
    if (!html) return // nothing to show — don't pop an empty box
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px', className: 'console-map-popup' })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map)
  }
  for (const id of [fill, line, circle, symbol]) {
    map.on('click', id, onClick)
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = '' })
  }
}

function reconcileAgentLayers(
  map: maplibregl.Map,
  layers: MapLayerMeta[],
  layerData: Record<string, unknown>,
  visible: Record<string, boolean>,
) {
  const desired = layers.filter((l) => visible[l.slug] !== false && layerData[l.slug])
  const want = new Set(desired.map((l) => l.slug))
  for (const srcId of Object.keys(map.getStyle()?.sources ?? {})) {
    if (srcId.startsWith('layer:') && !want.has(srcId.slice('layer:'.length))) removeAgentLayer(map, srcId.slice('layer:'.length))
  }
  for (const l of desired) addOrUpdateAgentLayer(map, l, layerData[l.slug] as GJ)
}

function LayersPanel({ onClose }: { onClose: () => void }) {
  const { layers, layerVisible, toggleLayer, setGroupVisible } = useMapStore()
  const groups = new Map<string, MapLayerMeta[]>()
  for (const l of layers) {
    const g = l.group || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(l)
  }
  return (
    <div className="absolute top-12 right-14 z-10 w-72 max-h-[70%] overflow-y-auto rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium">Layers</span>
        <button onClick={onClose}><X size={14} /></button>
      </div>
      {layers.length === 0 && (
        <p className="text-text-tertiary text-xs">No agent layers yet. Push one with <code>con map layer upsert &lt;group/name&gt; --file …</code></p>
      )}
      {[...groups.entries()].map(([g, ls]) => {
        const allOn = ls.every((l) => layerVisible[l.slug] !== false)
        return (
          <div key={g || '_'} className="mb-2">
            {g && (
              <label className="flex items-center gap-2 text-xs text-text-tertiary mb-1">
                <input type="checkbox" checked={allOn} onChange={() => setGroupVisible(g, !allOn)} />
                <span className="font-medium">{g}</span>
              </label>
            )}
            <div className={g ? 'pl-4 space-y-1' : 'space-y-1'}>
              {ls.map((l) => (
                <label key={l.slug} className="flex items-center justify-between gap-2 text-xs cursor-pointer">
                  <span className="flex items-center gap-2">
                    <input type="checkbox" checked={layerVisible[l.slug] !== false} onChange={() => toggleLayer(l.slug)} />
                    {l.name}
                  </span>
                  <span className="text-text-tertiary">{l.featureCount}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CredentialsPanel({ onClose }: { onClose: () => void }) {
  const { setCredentials, gcStatus, error } = useMapStore()
  const [mode, setMode] = useState<'password' | 'cookie'>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [cookie, setCookie] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      await setCredentials(mode === 'cookie' ? { cookie } : { username, password })
      onClose()
    } catch {/* error surfaces via store */} finally { setBusy(false) }
  }

  return (
    <div className="absolute top-12 left-2 z-10 w-80 rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium">geocaching.com</span>
        <button onClick={onClose}><X size={14} /></button>
      </div>
      {gcStatus?.loggedIn && <p className="text-text-tertiary mb-2 text-xs">Signed in as {gcStatus.username}. Re-enter to switch.</p>}
      <div className="flex gap-2 mb-2 text-xs">
        <button onClick={() => setMode('password')} className={`px-2 py-0.5 rounded ${mode === 'password' ? 'bg-surface-3' : 'bg-surface-1'}`}>Password</button>
        <button onClick={() => setMode('cookie')} className={`px-2 py-0.5 rounded ${mode === 'cookie' ? 'bg-surface-3' : 'bg-surface-1'}`}>Cookie</button>
      </div>
      {mode === 'password' ? (
        <>
          <input className="w-full mb-2 rounded bg-surface-1 border border-border px-2 py-1" placeholder="username or email" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className="w-full mb-2 rounded bg-surface-1 border border-border px-2 py-1" placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-text-tertiary text-xs mb-2">If a CAPTCHA blocks login, switch to the Cookie tab and paste your <code>gspkauth</code> cookie from a logged-in browser.</p>
        </>
      ) : (
        <>
          <textarea className="w-full mb-2 h-20 rounded bg-surface-1 border border-border px-2 py-1 font-mono text-xs" placeholder="paste your gspkauth cookie value" value={cookie} onChange={(e) => setCookie(e.target.value)} />
        </>
      )}
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <button onClick={() => void submit()} disabled={busy} className="w-full rounded bg-blue-600 hover:bg-blue-500 py-1 disabled:opacity-50">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </div>
  )
}

function CacheDetailPanel({ cache, onClose }: { cache: MapCache; onClose: () => void }) {
  const d = cache.detail
  return (
    <div className="absolute top-2 right-14 z-10 w-80 max-h-[80%] overflow-y-auto rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-start justify-between mb-1 gap-2">
        <div>
          <div className="font-medium leading-tight">{cache.name}</div>
          <div className="text-text-tertiary text-xs">{cache.code} · {cache.type} · {cache.size}</div>
        </div>
        <button onClick={onClose}><X size={14} /></button>
      </div>
      <div className="flex gap-3 text-xs text-text-secondary mb-2">
        <span>D {cache.difficulty}</span><span>T {cache.terrain}</span>
        <span>★ {cache.favorites}</span>
        {cache.found && <span className="text-green-400">found</span>}
        {cache.dnf && <span className="text-red-400">DNF</span>}
        {cache.pmOnly && <span className="text-amber-400">premium</span>}
      </div>
      {cache.owner && <div className="text-xs text-text-tertiary mb-2">by {cache.owner}{cache.hidden ? ` · ${cache.hidden}` : ''}</div>}
      {!d ? (
        <div className="text-text-tertiary text-xs flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> loading detail…</div>
      ) : (
        <>
          {d.hint && <div className="mb-2"><div className="text-text-tertiary text-xs">Hint</div><div className="text-xs">{d.hint}</div></div>}
          {d.attributes.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {d.attributes.filter((a) => a.enabled).map((a) => (
                <span key={a.slug} className="text-[10px] rounded bg-surface-2 px-1.5 py-0.5">{a.label}</span>
              ))}
            </div>
          )}
          {d.logs.length > 0 && (
            <div>
              <div className="text-text-tertiary text-xs mb-1">Recent logs</div>
              <ul className="space-y-1.5">
                {d.logs.slice(0, 8).map((l) => (
                  <li key={l.id} className="text-xs border-l-2 pl-2" style={{ borderColor: logColor(l.type) }}>
                    <span className="text-text-tertiary">{l.date} · </span>
                    <span style={{ color: logColor(l.type) }}>{l.type.replace(/_/g, ' ')}</span>
                    <span className="text-text-tertiary"> · {l.author}</span>
                    {l.text && <div className="line-clamp-3 whitespace-pre-line text-text-secondary">{stripHtml(l.text)}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <a
        href={`https://www.geocaching.com/geocache/${cache.code}`} target="_blank" rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
      >
        <MapPin size={11} /> open on geocaching.com
      </a>
    </div>
  )
}
