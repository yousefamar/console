import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection } from 'geojson'
import { Crosshair, Download, MapPin, X, KeyRound, Loader2, HardDriveDownload, Check } from 'lucide-react'
import { useMapStore, type MapCache, type OtFix } from '@/store/map'
import { ensurePmtilesProtocol } from '@/map/pmtiles-source'
import { styleForRegion, downloadRegion, isRegionOffline } from '@/map/offline-basemap'
import { mapController } from '@/map/controller'

const BASEMAP_REGION = 'uk'

const TYPE_COLORS: unknown[] = [
  'match', ['get', 'type'],
  'Traditional', '#22c55e',
  'Multi-cache', '#f59e0b',
  'Mystery', '#3b82f6',
  'EarthCache', '#84cc16',
  'Letterbox', '#a855f7',
  'Virtual', '#06b6d4',
  'Wherigo', '#ec4899',
  'Event', '#ef4444',
  'Mega-Event', '#ef4444',
  'Giga-Event', '#ef4444',
  /* default */ '#9ca3af',
]

function pinsToFC(pins: MapCache[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pins
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon as number, p.lat as number] },
        properties: { code: p.code, type: p.type, found: p.found ? 1 : 0 },
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
  const [offline, setOffline] = useState(false)
  const [dlPct, setDlPct] = useState<number | null>(null)

  // --- init map (once) ------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    let cancelled = false
    let map: maplibregl.Map | null = null
    ensurePmtilesProtocol()

    void (async () => {
      const style = await styleForRegion(BASEMAP_REGION)
      if (cancelled || !containerRef.current) return
      map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: [-2, 54],
        zoom: 5,
        attributionControl: false,
      })
      mapRef.current = map
      void isRegionOffline(BASEMAP_REGION).then((v) => !cancelled && setOffline(v))
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      map.on('error', () => {/* tolerate a missing basemap — background still renders */})

      // (Re)add overlay layers on every style load — fires on first load AND
      // after setStyle (e.g. swapping to the offline archive after download).
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
      map.on('mouseenter', 'gc-pins', () => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'gc-pins', () => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = '' })

      mapController.flyToMe = () => {
        const c = useMapStore.getState().current[0]
        if (c && mapRef.current) mapRef.current.flyTo({ center: [c.lon, c.lat], zoom: 14 })
      }
      mapController.fetchHere = () => {
        const m = mapRef.current
        if (!m) return
        const b = m.getBounds()
        void useMapStore.getState().fetchArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]).catch(() => {})
      }
    })()

    return () => {
      cancelled = true
      mapController.flyToMe = undefined
      mapController.fetchHere = undefined
      map?.remove()
      mapRef.current = null
      readyRef.current = false
    }
  }, [selectCache])

  const downloadOffline = async () => {
    setDlPct(0)
    try {
      await downloadRegion(BASEMAP_REGION, (f) => setDlPct(f))
      const style = await styleForRegion(BASEMAP_REGION)
      mapRef.current?.setStyle(style) // → style.load re-adds overlays
      setOffline(true)
    } catch (e) {
      useMapStore.setState({ error: (e as Error).message })
    } finally {
      setDlPct(null)
    }
  }

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
          onClick={() => { if (!offline && dlPct === null) void downloadOffline() }}
          disabled={dlPct !== null}
          title={offline ? 'Basemap available offline' : 'Download this region for offline use'}
          className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur hover:bg-surface-2 disabled:opacity-60"
        >
          {dlPct !== null ? (
            <><Loader2 size={12} className="animate-spin" /> {Math.round(dlPct * 100)}%</>
          ) : offline ? (
            <><Check size={12} className="text-green-400" /> Offline</>
          ) : (
            <><HardDriveDownload size={12} /> Offline</>
          )}
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

      {showCreds && <CredentialsPanel onClose={() => setShowCreds(false)} />}
      {selected && <CacheDetailPanel cache={selected} onClose={() => void selectCache(null)} />}
    </div>
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
        'circle-color': TYPE_COLORS as unknown as maplibregl.ExpressionSpecification,
        'circle-opacity': ['case', ['==', ['get', 'found'], 1], 0.4, 0.92] as unknown as maplibregl.ExpressionSpecification,
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
      paint: { 'circle-radius': 7, 'circle-color': '#f59e0b', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
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
              <ul className="space-y-1">
                {d.logs.slice(0, 8).map((l) => (
                  <li key={l.id} className="text-xs">
                    <span className="text-text-tertiary">{l.date} · {l.type.replace(/_/g, ' ')} · {l.author}</span>
                    {l.text && <div className="line-clamp-3 text-text-secondary">{l.text}</div>}
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
