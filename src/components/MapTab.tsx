import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection } from 'geojson'
import { Crosshair, Download, MapPin, X, KeyRound, Loader2 } from 'lucide-react'
import { useMapStore, type MapCache, type OtFix } from '@/store/map'
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

// Pins are coloured by YOUR relationship to the cache, not its type (the type
// lives in the popup). found = green, DNF = red, not-yet-attempted = muted slate.
const FOUND = '#22c55e'
const DNF = '#ef4444'
const TODO = '#64748b'
const STATE_COLOR: unknown[] = [
  'case',
  ['==', ['get', 'found'], 1], FOUND,
  ['==', ['get', 'dnf'], 1], DNF,
  TODO,
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
    refresh, loadHistory, selectCache, setRange,
  } = useMapStore()

  const [showCreds, setShowCreds] = useState(false)

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

    // Add overlay layers once the style is ready (fires on initial load).
    map.on('style.load', () => {
      const m = mapRef.current
      if (!m) return
      addOverlayLayers(m)
      readyRef.current = true
      pushSource(m, 'gc-pins', pinsToFC(useMapStore.getState().pins))
      pushSource(m, 'ot-track', trackToFC(useMapStore.getState().track))
      pushSource(m, 'ot-current', currentToFC(useMapStore.getState().current))
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
            onChange={(e) => setRange(new Date(e.target.value).getTime(), rangeTo)}
            className="bg-transparent outline-none w-[7.5rem]"
          />
          <span className="text-text-tertiary">→</span>
          <input
            type="date" value={ymd(rangeTo)}
            onChange={(e) => setRange(rangeFrom, new Date(e.target.value).getTime())}
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

        {budget && (
          <span className="rounded bg-surface-0/90 border border-border px-2 py-1 text-text-tertiary backdrop-blur">
            {budget.remaining}/{budget.cap} left · {pins.length} caches
          </span>
        )}
        {error && <span className="rounded bg-red-500/20 text-red-300 border border-red-500/40 px-2 py-1">{error}</span>}
      </div>

      {/* legend — pins coloured by your find-state */}
      <div className="absolute bottom-2 left-2 flex items-center gap-3 rounded bg-surface-0/90 border border-border px-2 py-1 text-[11px] text-text-secondary backdrop-blur">
        <Dot color={FOUND} label="found" />
        <Dot color={DNF} label="DNF" />
        <Dot color={TODO} label="to do" />
      </div>

      {showCreds && <CredentialsPanel onClose={() => setShowCreds(false)} />}
      {selected && <CacheDetailPanel cache={selected} onClose={() => void selectCache(null)} />}
    </div>
  )
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
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
    map.addLayer({
      id: 'gc-pins', type: 'circle', source: 'gc-pins',
      paint: {
        'circle-radius': 6,
        'circle-color': STATE_COLOR as unknown as maplibregl.ExpressionSpecification,
        'circle-opacity': ['case', ['==', ['get', 'found'], 1], 0.95, ['==', ['get', 'dnf'], 1], 0.95, 0.7] as unknown as maplibregl.ExpressionSpecification,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#0a0a0a',
      },
    })
    map.addLayer({
      id: 'gc-selected', type: 'circle', source: 'gc-pins',
      filter: ['==', ['get', 'code'], ''],
      paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
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
