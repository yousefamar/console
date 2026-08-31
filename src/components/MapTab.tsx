import { Fragment, useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './map-popup.css'
import type { FeatureCollection } from 'geojson'
import { Crosshair, Download, MapPin, X, KeyRound, Loader2, Layers as LayersIcon, Clock, Calendar, Users, Search, Navigation, ExternalLink, Car, Footprints, Bike, Train, Locate } from 'lucide-react'
import { useMapStore, type MapCache, type OtFix, type MapLayerMeta, type MapLayerStyle, type LayerFeatureSel, type MeetupEvent, type BuiltinLayerId, type GPlace, type GRoute, type GTravelMode } from '@/store/map'
import type { FeatureCollection as GJ } from 'geojson'
import { basemapStyleUrl } from '@/map/basemap-style'
import { mapController } from '@/map/controller'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { hubFetch } from '@/hub'

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

// Meetup events are a single calendar glyph (their find-state/type has no map
// meaning the way a geocache's does). Online events have no venue → no pin.
const MEETUP_EMOJI = '📅'

function eventsToFC(events: MeetupEvent[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: events
      .filter((e) => e.lat != null && e.lon != null)
      .map((e) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon as number, e.lat as number] },
        properties: { id: e.id },
      })),
  }
}

// Google Maps search results are a single pin glyph. The selected place gets a
// ring (like geocache/meetup selection).
const GMAPS_EMOJI = '📍'

function placesToFC(places: GPlace[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { id: p.id },
    })),
  }
}

// Alternate routes render as separate LineStrings; the selected one is drawn
// bright + wide, the others dimmed. `sel` marks which index is emphasized.
function routesToFC(routes: GRoute[], sel: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: routes.map((r, i) => ({
      type: 'Feature',
      geometry: r.geometry,
      properties: { idx: i, selected: i === sel ? 1 : 0 },
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
    events, selectedEventId, meetupStatus, fetchingMeetup,
    meetupDays,
    selectEvent, setMeetupDays,
    selectedLayerFeature, selectLayerFeature,
    builtinVisible,
    gmapsConfigured, gmapsResults, gmapsSelectedPlaceId, gmapsRoutes, gmapsSelectedRoute,
    probeGmaps, selectPlace,
  } = useMapStore()

  const isMobile = useIsMobile()
  const darkMode = useUiStore((s) => s.darkMode)
  const [showCreds, setShowCreds] = useState(false)
  const [showLayers, setShowLayers] = useState(false)
  const [showGmaps, setShowGmaps] = useState(false)
  const [glError, setGlError] = useState<string | null>(null)
  const [rangeSel, setRangeSel] = useState('1') // days; '1' = last 24h, 'custom' = date pickers
  const fittedRef = useRef<Set<string>>(new Set())

  const onRangeChange = (v: string) => {
    setRangeSel(v)
    if (v !== 'custom') void loadHistory(Date.now() - Number(v) * 86400000, Date.now())
  }

  // --- init map (once) ------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    // MapLibre throws synchronously ("Failed to initialize WebGL") when no GL
    // context is available (GPU blocklist, headless, exhausted contexts). An
    // uncaught throw here unwinds the whole React tree and blanks the entire
    // app — so contain it to a Map-pane-only error.
    let map: maplibregl.Map
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: basemapStyleUrl(useUiStore.getState().darkMode),
        center: [-2, 54],
        zoom: 5,
        attributionControl: false,
      })
    } catch (err) {
      setGlError((err as Error)?.message || 'Failed to initialize WebGL')
      return
    }
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', () => {/* tolerate the odd tile 404 — non-fatal */})
    registerEmojiImages(map)

    // Add overlay layers once the style is ready. Fires on the initial load
    // AND after every map.setStyle (theme swap) — a style swap wipes all
    // sources/layers/filters, so everything is re-derived from the store here.
    map.on('style.load', () => {
      const m = mapRef.current
      if (!m) return
      addOverlayLayers(m)
      readyRef.current = true
      const st = useMapStore.getState()
      pushSource(m, 'gc-pins', pinsToFC(st.pins))
      pushSource(m, 'meetup-pins', eventsToFC(st.events))
      pushSource(m, 'ot-track', trackToFC(st.track))
      pushSource(m, 'ot-current', currentToFC(st.current))
      pushSource(m, 'gmaps-pins', placesToFC(st.gmapsResults))
      pushSource(m, 'gmaps-routes', routesToFC(st.gmapsRoutes, st.gmapsSelectedRoute))
      m.setFilter('gc-selected', ['==', ['get', 'code'], st.selectedCode ?? ''])
      m.setFilter('meetup-selected', ['==', ['get', 'id'], st.selectedEventId ?? ''])
      m.setFilter('gmaps-selected', ['==', ['get', 'id'], st.gmapsSelectedPlaceId ?? ''])
      applyBuiltinVisibility(m, st.builtinVisible)
      reconcileAgentLayers(m, st.layers, st.layerData, st.layerVisible)
    })

    // Layer-scoped handlers bind once (deferred by layer id is fine in MapLibre).
    map.on('click', 'gc-pins', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined
      if (code) void selectCache(code)
    })
    map.on('mouseenter', 'gc-pins', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'gc-pins', () => { map.getCanvas().style.cursor = '' })

    map.on('click', 'meetup-pins', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined
      if (id) void selectEvent(id)
    })
    map.on('mouseenter', 'meetup-pins', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'meetup-pins', () => { map.getCanvas().style.cursor = '' })

    map.on('click', 'gmaps-pins', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined
      if (id) useMapStore.getState().selectPlace(id)
    })
    map.on('mouseenter', 'gmaps-pins', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'gmaps-pins', () => { map.getCanvas().style.cursor = '' })

    map.on('click', 'gmaps-routes', (e) => {
      const idx = e.features?.[0]?.properties?.idx as number | undefined
      if (idx != null) useMapStore.getState().selectRoute(idx)
    })
    map.on('mouseenter', 'gmaps-routes', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'gmaps-routes', () => { map.getCanvas().style.cursor = '' })

    mapController.center = () => {
      const m = mapRef.current
      if (!m) return null
      const c = m.getCenter()
      return { lat: c.lat, lon: c.lng }
    }
    mapController.flyToMe = () => {
      const c = useMapStore.getState().current[0]
      if (c) map.flyTo({ center: [c.lon, c.lat], zoom: 14 })
    }
    mapController.fetchHere = () => {
      const b = map.getBounds()
      void useMapStore.getState().fetchArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]).catch(() => {})
    }
    mapController.fetchMeetupHere = () => {
      const b = map.getBounds()
      void useMapStore.getState().fetchMeetupArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]).catch(() => {})
    }

    return () => {
      mapController.flyToMe = undefined
      mapController.fetchHere = undefined
      mapController.fetchMeetupHere = undefined
      mapController.center = undefined
      map.remove()
      mapRef.current = null
      readyRef.current = false
    }
  }, [selectCache])

  // Theme change → swap the basemap style. setStyle wipes all sources/layers;
  // the style.load handler above re-attaches everything from the store. Gate
  // on readyRef so the initial load (style passed to the constructor) isn't
  // double-fetched.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    readyRef.current = false
    map.setStyle(basemapStyleUrl(darkMode))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode])

  // initial data load
  useEffect(() => {
    void refresh().then(() => void loadHistory())
    void loadLayers()
    void probeGmaps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // push store slices → map sources
  useEffect(() => { if (readyRef.current && mapRef.current) pushSource(mapRef.current, 'gc-pins', pinsToFC(pins)) }, [pins])
  useEffect(() => { if (readyRef.current && mapRef.current) pushSource(mapRef.current, 'meetup-pins', eventsToFC(events)) }, [events])
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
  useEffect(() => {
    const map = mapRef.current
    if (readyRef.current && map) map.setFilter('meetup-selected', ['==', ['get', 'id'], selectedEventId ?? ''])
  }, [selectedEventId])

  // Google Maps search pins + selection ring + fit-to-results
  const gmapsFittedRef = useRef<string>('')
  useEffect(() => {
    const map = mapRef.current
    if (!readyRef.current || !map) return
    pushSource(map, 'gmaps-pins', placesToFC(gmapsResults))
    // Fit to the result set once per distinct result batch.
    const key = gmapsResults.map((p) => p.id).join(',')
    if (gmapsResults.length && key !== gmapsFittedRef.current) {
      gmapsFittedRef.current = key
      if (gmapsResults.length === 1) {
        const p = gmapsResults[0]!
        map.flyTo({ center: [p.lon, p.lat], zoom: 15, duration: 600 })
      } else {
        const b = new maplibregl.LngLatBounds()
        for (const p of gmapsResults) b.extend([p.lon, p.lat])
        map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 })
      }
    }
    if (!gmapsResults.length) gmapsFittedRef.current = ''
  }, [gmapsResults])
  useEffect(() => {
    const map = mapRef.current
    if (readyRef.current && map) map.setFilter('gmaps-selected', ['==', ['get', 'id'], gmapsSelectedPlaceId ?? ''])
  }, [gmapsSelectedPlaceId])

  // Google Maps directions polylines (selected route emphasized)
  useEffect(() => {
    const map = mapRef.current
    if (!readyRef.current || !map) return
    pushSource(map, 'gmaps-routes', routesToFC(gmapsRoutes, gmapsSelectedRoute))
    if (gmapsRoutes.length) {
      const b = new maplibregl.LngLatBounds()
      for (const r of gmapsRoutes) for (const c of r.geometry.coordinates) b.extend(c as [number, number])
      map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 })
    }
  }, [gmapsRoutes, gmapsSelectedRoute])

  // built-in layer visibility → toggle the MapLibre layer `visibility` prop
  useEffect(() => {
    const map = mapRef.current
    if (readyRef.current && map) applyBuiltinVisibility(map, builtinVisible)
  }, [builtinVisible])

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
  const selectedEvent = events.find((e) => e.id === selectedEventId) ?? null
  const selectedPlace = gmapsResults.find((p) => p.id === gmapsSelectedPlaceId) ?? null
  const budget = gcStatus?.budget
  const meetupBudget = meetupStatus?.budget

  return (
    <div className="relative flex flex-1 min-h-0">
      <div ref={containerRef} className="flex-1 min-h-0" />

      {glError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-6 bg-surface-0">
          <div className="max-w-sm text-center text-sm text-text-secondary">
            <p className="font-medium text-text-primary mb-1">Map unavailable</p>
            <p className="mb-2">{glError}</p>
            <p className="text-xs text-text-tertiary">WebGL is required to render the map. Check that hardware acceleration is enabled in your browser, then reload.</p>
          </div>
        </div>
      )}

      {/* top toolbar — the Layers button is always present; each layer's own
          control cluster appears only while that layer is visible. */}
      <div className="absolute top-2 left-2 right-14 flex flex-wrap items-center gap-1.5 text-xs">
        {/* layers */}
        <button onClick={() => setShowLayers((v) => !v)} title="Map layers"
          className="flex items-center gap-1 rounded bg-surface-0/90 border border-border px-2 py-1 backdrop-blur hover:bg-surface-2">
          <LayersIcon size={13} /><span className="text-text-tertiary">{layers.length + 3}</span>
        </button>

        {/* google maps: search + directions */}
        <button onClick={() => setShowGmaps((v) => !v)} title="Search Google Maps"
          className={`flex items-center gap-1 rounded border border-border px-2 py-1 backdrop-blur hover:bg-surface-2 ${showGmaps ? 'bg-surface-2' : 'bg-surface-0/90'}`}>
          <Search size={13} />{gmapsResults.length > 0 && <span className="text-text-tertiary">{gmapsResults.length}</span>}
        </button>

        {/* location: time range + device + centre-on-me */}
        {builtinVisible.location && (
          <>
            <div className="flex items-center gap-1 rounded bg-surface-0/90 border border-border pl-2 pr-1 py-1 backdrop-blur">
              {loadingHistory ? <Loader2 size={12} className="animate-spin text-text-tertiary" /> : <Clock size={12} className="text-text-tertiary" />}
              <select value={rangeSel} onChange={(e) => onRangeChange(e.target.value)} className="bg-transparent outline-none cursor-pointer [&>option]:bg-surface-0 [&>option]:text-text-primary">
                <option value="1">Last 24h</option>
                <option value="2">Last 48h</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last year</option>
                <option value="custom">Custom…</option>
              </select>
              {rangeSel === 'custom' && (
                <>
                  <input type="date" value={ymd(rangeFrom)} onChange={(e) => e.target.value && void loadHistory(new Date(e.target.value).getTime(), rangeTo)} className="bg-transparent outline-none w-[7rem]" />
                  <span className="text-text-tertiary">→</span>
                  <input type="date" value={ymd(rangeTo)} onChange={(e) => e.target.value && void loadHistory(rangeFrom, new Date(e.target.value).getTime())} className="bg-transparent outline-none w-[7rem]" />
                </>
              )}
              {devices.length > 1 && (
                <select value={device ?? ''} onChange={(e) => void loadHistory(undefined, undefined, e.target.value)} className="bg-transparent outline-none border-l border-border pl-1 [&>option]:bg-surface-0 [&>option]:text-text-primary">
                  {devices.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
            </div>
            <button onClick={() => mapController.flyToMe?.()} title="Centre on my location"
              className="flex items-center rounded bg-surface-0/90 border border-border p-1.5 backdrop-blur hover:bg-surface-2">
              <Crosshair size={13} />
            </button>
          </>
        )}

        {/* geocaching: sign-in + (when logged in) fetch */}
        {builtinVisible.geocaches && (
          <div className="flex items-center rounded bg-surface-0/90 border border-border backdrop-blur overflow-hidden">
            <button onClick={() => setShowCreds((v) => !v)} title="geocaching.com account"
              className="flex items-center gap-1 px-2 py-1 hover:bg-surface-2">
              <KeyRound size={13} />{gcStatus?.loggedIn ? gcStatus.username : 'Sign in'}
            </button>
            {gcStatus?.loggedIn && (
              <button onClick={() => mapController.fetchHere?.()} disabled={fetching}
                title={`Fetch geocaches in view · ${budget?.remaining ?? '?'} requests left today`}
                className="flex items-center gap-1 px-2 py-1 border-l border-border hover:bg-surface-2 disabled:opacity-50">
                {fetching ? <Loader2 size={12} className="animate-spin" /> : <Download size={13} />}
                {budget && <span className="text-text-tertiary">{budget.remaining}</span>}
              </button>
            )}
          </div>
        )}

        {/* meetup: date window + fetch (wildcard search by default) */}
        {builtinVisible.meetup && (
          <div className="flex items-center rounded bg-surface-0/90 border border-border backdrop-blur overflow-hidden">
            <span className="pl-2 pr-1 text-text-tertiary" title="Meetup events near here"><Calendar size={13} /></span>
            <select value={meetupDays} onChange={(e) => setMeetupDays(Number(e.target.value))}
              title="Time window" className="bg-transparent outline-none px-1 py-1 cursor-pointer [&>option]:bg-surface-0 [&>option]:text-text-primary">
              <option value={0}>Upcoming</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            <button onClick={() => mapController.fetchMeetupHere?.()} disabled={fetchingMeetup}
              title={`Fetch Meetup events in view · ${meetupBudget?.remaining ?? '?'} requests left today`}
              className="flex items-center gap-1 px-2 py-1 border-l border-border hover:bg-surface-2 disabled:opacity-50">
              {fetchingMeetup ? <Loader2 size={12} className="animate-spin" /> : <Download size={13} />}
              {meetupBudget && <span className="text-text-tertiary">{meetupBudget.remaining}</span>}
            </button>
          </div>
        )}

        {error && <span className="rounded bg-red-500/20 text-red-300 border border-red-500/40 px-2 py-1">{error}</span>}
      </div>

      {showCreds && <CredentialsPanel onClose={() => setShowCreds(false)} />}
      {showLayers && <LayersPanel onClose={() => setShowLayers(false)} />}
      {showGmaps && <GmapsPanel isMobile={isMobile} configured={gmapsConfigured} onClose={() => setShowGmaps(false)} />}
      {selected && <CacheDetailPanel cache={selected} onClose={() => void selectCache(null)} />}
      {selectedLayerFeature && (
        <LayerFeaturePanel sel={selectedLayerFeature} onClose={() => selectLayerFeature(null)} />
      )}
      {selectedEvent && <MeetupEventPanel event={selectedEvent} onClose={() => void selectEvent(null)} />}
      {selectedPlace && !showGmaps && (
        <PlaceDetailPanel place={selectedPlace} isMobile={isMobile} onClose={() => selectPlace(null)} />
      )}
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

// Built-in layers ↔ their MapLibre sublayer ids. The Layers panel and the
// toolbar both key off the same three ids, so location/geocaches/meetup toggle
// exactly like agent layers do.
const BUILTIN_SUBLAYERS: Record<BuiltinLayerId, string[]> = {
  location: ['ot-track', 'ot-current'],
  geocaches: ['gc-selected', 'gc-pins'],
  meetup: ['meetup-selected', 'meetup-pins'],
}

function applyBuiltinVisibility(map: maplibregl.Map, visible: Record<BuiltinLayerId, boolean>) {
  for (const [id, sublayers] of Object.entries(BUILTIN_SUBLAYERS) as [BuiltinLayerId, string[]][]) {
    const v = visible[id] === false ? 'none' : 'visible'
    for (const sl of sublayers) {
      if (map.getLayer(sl)) map.setLayoutProperty(sl, 'visibility', v)
    }
  }
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
  if (!map.getSource('meetup-pins')) {
    map.addSource('meetup-pins', { type: 'geojson', data: eventsToFC([]) })
    map.addLayer({
      id: 'meetup-selected', type: 'circle', source: 'meetup-pins',
      filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': 14, 'circle-color': 'rgba(255,74,121,0.25)', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
    })
    map.addLayer({
      id: 'meetup-pins', type: 'symbol', source: 'meetup-pins',
      layout: {
        'icon-image': `em:${MEETUP_EMOJI}`,
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
  // Google Maps directions routes — drawn beneath the search pins. A casing
  // line under the main line gives the classic Google route look; the selected
  // route is bright blue + wide, alternates are dimmed grey.
  if (!map.getSource('gmaps-routes')) {
    map.addSource('gmaps-routes', { type: 'geojson', data: routesToFC([], 0) })
    map.addLayer({
      id: 'gmaps-routes-casing', type: 'line', source: 'gmaps-routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#0a0a0a',
        'line-width': ['case', ['==', ['get', 'selected'], 1], 9, 6] as unknown as maplibregl.ExpressionSpecification,
        'line-opacity': 0.5,
      },
    })
    map.addLayer({
      id: 'gmaps-routes', type: 'line', source: 'gmaps-routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'selected'], 1], '#4285F4', '#9ca3af'] as unknown as maplibregl.ExpressionSpecification,
        'line-width': ['case', ['==', ['get', 'selected'], 1], 6, 3.5] as unknown as maplibregl.ExpressionSpecification,
        'line-opacity': ['case', ['==', ['get', 'selected'], 1], 0.95, 0.6] as unknown as maplibregl.ExpressionSpecification,
      },
    })
  }
  if (!map.getSource('gmaps-pins')) {
    map.addSource('gmaps-pins', { type: 'geojson', data: placesToFC([]) })
    map.addLayer({
      id: 'gmaps-selected', type: 'circle', source: 'gmaps-pins',
      filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': 14, 'circle-color': 'rgba(66,133,244,0.25)', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
    })
    map.addLayer({
      id: 'gmaps-pins', type: 'symbol', source: 'gmaps-pins',
      layout: {
        'icon-image': `em:${GMAPS_EMOJI}`,
        'icon-size': 0.6,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
  }
}

// --- agent-authored layers ---------------------------------------------------

type Expr = maplibregl.ExpressionSpecification
const expr = (v: unknown) => v as unknown as Expr

function subIds(slug: string) {
  const b = `layer:${slug}`
  return { src: b, fill: `${b}:fill`, line: `${b}:line`, circle: `${b}:circle`, symbol: `${b}:symbol`, label: `${b}:label` }
}

function removeAgentLayer(map: maplibregl.Map, slug: string) {
  const { src, fill, line, circle, symbol, label } = subIds(slug)
  animatedLineLayers.delete(line)
  for (const id of [fill, line, circle, symbol, label]) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(src)) map.removeSource(src)
}

// --- animated line dashes (marching ants) for flight arcs --------------------
// MapLibre has no runtime lineDashOffset, so we cycle line-dasharray through a
// precomputed sequence via setPaintProperty — the standard "ant-path" trick.
// One shared rAF loop drives every layer flagged style.animated; it idles
// (stops) when none are registered and restarts on the next register.
const animatedLineLayers = new Map<string, maplibregl.Map>()
// Constant-period dash sequence (every entry sums to 7) — this is what keeps
// the march smooth and continuous. Adapted from the canonical MapLibre/Mapbox
// "animated line" example; cycling these via setPaintProperty gives marching
// ants without the jank a variable-period sequence produces.
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
]
const DASH_STEP_MS = 130 // dwell per frame — higher = slower, calmer drift
let dashStep = -1
let dashRaf: number | null = null
function ensureDashLoop() {
  if (dashRaf != null) return
  // Timestamp-driven (frame-rate independent): advance only when the step
  // index changes, so the cadence is even regardless of display refresh rate.
  const tick = (t: number) => {
    if (animatedLineLayers.size === 0) { dashRaf = null; dashStep = -1; return }
    const step = Math.floor(t / DASH_STEP_MS) % DASH_SEQUENCE.length
    if (step !== dashStep) {
      dashStep = step
      for (const [id, m] of animatedLineLayers) {
        // Skip while the Map pane is display:none (pre-rendered panes stay
        // mounted) — each setPaintProperty forces a full maplibre re-render,
        // which was burning main-thread time under every other pane.
        if (m.getContainer().offsetParent === null) continue
        if (m.getLayer(id)) {
          try { m.setPaintProperty(id, 'line-dasharray', DASH_SEQUENCE[step]) } catch { /* style mid-reload */ }
        } else {
          animatedLineLayers.delete(id)
        }
      }
    }
    dashRaf = requestAnimationFrame(tick)
  }
  dashRaf = requestAnimationFrame(tick)
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
  const { src, fill, line, circle, symbol, label } = subIds(meta.slug)
  const existing = map.getSource(src) as maplibregl.GeoJSONSource | undefined
  if (existing) { existing.setData(data); return }
  const st = meta.style || {}
  const before = map.getLayer('gc-pins') ? 'gc-pins' : undefined

  map.addSource(src, { type: 'geojson', data })
  // Polygon-only guard: without it MapLibre auto-closes LineStrings (arc + chord)
  // and fills the enclosed wedge — the translucent shadow under flight arcs.
  // Mirrors the Point guard on the circle sublayer below.
  map.addLayer({
    id: fill, type: 'fill', source: src,
    filter: ['==', ['geometry-type'], 'Polygon'] as maplibregl.FilterSpecification,
    paint: { 'fill-color': st.fillColor ?? '#3b82f6', 'fill-opacity': st.fillOpacity ?? 0.15 },
  }, before)
  map.addLayer({
    id: line, type: 'line', source: src,
    // Butt caps on animated lines: round caps turn the sequence's zero-length
    // dashes into blinking dots. Non-animated lines keep round for smooth bends.
    layout: { 'line-cap': st.animated ? 'butt' : 'round', 'line-join': 'round' },
    paint: {
      'line-color': expr(['coalesce', ['get', '_color'], st.strokeColor ?? st.lineColor ?? '#3b82f6']),
      'line-width': st.strokeWidth ?? st.lineWidth ?? 1.5,
      ...(st.animated ? { 'line-dasharray': [0, 4, 3] as unknown as Expr } : {}),
    },
  }, before)
  if (st.animated) { animatedLineLayers.set(line, map); ensureDashLoop() }
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
  // Text labels (e.g. flight price/date). Needs the style's glyphs URL.
  map.addLayer({
    id: label, type: 'symbol', source: src,
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', '_label']] as maplibregl.FilterSpecification,
    layout: {
      'text-field': expr(['get', '_label']),
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 0.6],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': expr(['coalesce', ['get', '_color'], '#a5f3fc']),
      'text-halo-color': '#04141a',
      'text-halo-width': 1.8,
    },
  }, before)

  const onClick = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) return
    const props = (f.properties ?? {}) as Record<string, unknown>
    if (st.panel) {
      useMapStore.getState().selectLayerFeature({ slug: meta.slug, props })
      return
    }
    const html = buildPopupHtml(props, st)
    if (!html) return // nothing to show — don't pop an empty box
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px', className: 'console-map-popup' })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map)
  }
  for (const id of [fill, line, circle, symbol, label]) {
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

const BUILTIN_META: { id: BuiltinLayerId; label: string; icon: string }[] = [
  { id: 'location', label: 'Location history', icon: '🔵' },
  { id: 'geocaches', label: 'Geocaches', icon: '📦' },
  { id: 'meetup', label: 'Meetup events', icon: '📅' },
]

function LayersPanel({ onClose }: { onClose: () => void }) {
  const { layers, layerVisible, toggleLayer, setGroupVisible, builtinVisible, toggleBuiltin, pins, events } = useMapStore()
  const groups = new Map<string, MapLayerMeta[]>()
  for (const l of layers) {
    const g = l.group || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(l)
  }
  const builtinCount: Record<BuiltinLayerId, number | null> = {
    location: null,
    geocaches: pins.filter((p) => p.lat != null && p.lon != null).length,
    meetup: events.filter((e) => e.lat != null && e.lon != null).length,
  }
  return (
    <div className="absolute top-12 left-2 z-10 w-72 max-h-[70%] overflow-y-auto rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium">Layers</span>
        <button onClick={onClose}><X size={14} /></button>
      </div>

      {/* built-in hub-backed layers */}
      <div className="space-y-1 mb-3">
        {BUILTIN_META.map((b) => (
          <label key={b.id} className="flex items-center justify-between gap-2 text-xs cursor-pointer">
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={builtinVisible[b.id]} onChange={() => toggleBuiltin(b.id)} />
              <span>{b.icon} {b.label}</span>
            </span>
            {builtinCount[b.id] != null && <span className="text-text-tertiary">{builtinCount[b.id]}</span>}
          </label>
        ))}
      </div>

      {layers.length > 0 && <div className="border-t border-border pt-2 mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">Agent layers</div>}
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

// Keys the panel renders specially (hero image, title, link, badges); anything
// else falls through to plain key→value rows so non-property layers work too.
const PANEL_SPECIAL = new Set([
  'image', 'title', 'address', 'url', 'price', 'portal', 'summary',
  '_color', '_size', '_icon', '_label',
  // Property-only plumbing for the dismiss action below — not for display.
  'listingId', 'searchId',
])

function LayerFeaturePanel({ sel, onClose }: { sel: LayerFeatureSel; onClose: () => void }) {
  const p = sel.props
  const s = (k: string): string | undefined => (p[k] != null && p[k] !== '' ? String(p[k]) : undefined)
  const rows = Object.keys(p).filter((k) => !PANEL_SPECIAL.has(k) && p[k] != null && p[k] !== '')
  const url = s('url')
  const listingId = s('listingId')
  const searchId = s('searchId')
  const [dismissing, setDismissing] = useState(false)

  const dismiss = async () => {
    if (!listingId || !searchId || dismissing) return
    setDismissing(true)
    try {
      await hubFetch(`/property/searches/${encodeURIComponent(searchId)}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId }),
      })
      onClose()
    } catch {
      setDismissing(false)
    }
  }

  return (
    <div className="absolute top-2 right-14 z-10 w-80 max-h-[80%] overflow-y-auto rounded border border-border bg-surface-0 text-sm shadow-xl">
      {s('image') && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={s('image')} alt="" className="w-full h-44 object-cover rounded-t" loading="lazy" />
        </a>
      )}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div>
            {s('price') && <div className="font-semibold text-base leading-tight">{s('price')}</div>}
            {s('title') && <div className={s('price') ? 'text-text-secondary text-xs mt-0.5' : 'font-medium leading-tight'}>{s('title')}</div>}
            {s('address') && <div className="text-text-tertiary text-xs mt-0.5">{s('address')}</div>}
          </div>
          <button onClick={onClose} className="shrink-0"><X size={14} /></button>
        </div>
        {rows.length > 0 && (
          <div className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {rows.map((k) => (
              <Fragment key={k}>
                <span className="text-text-tertiary">{k}</span>
                <span className="text-text-secondary break-words">{String(p[k])}</span>
              </Fragment>
            ))}
          </div>
        )}
        {s('summary') && <p className="text-xs text-text-secondary whitespace-pre-line mb-2">{s('summary')}</p>}
        <div className="flex items-center justify-between gap-2 mt-1">
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline">
              <ExternalLink size={11} /> open on {s('portal') ?? new URL(url).hostname.replace(/^www\./, '')}
            </a>
          )}
          {listingId && searchId && (
            <button
              onClick={dismiss}
              disabled={dismissing}
              className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-red-400 disabled:opacity-50 shrink-0"
              title="Hide this listing from the map — permanent, survives future polls"
            >
              <X size={11} /> {dismissing ? 'hiding…' : 'not interested'}
            </button>
          )}
        </div>
      </div>
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

// --- Google Maps search + directions UI -------------------------------------

function fmtDuration(sec: number): string {
  if (sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m} min`
  return `${sec}s`
}

function fmtDistance(m: number): string {
  if (m <= 0) return ''
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
}

/** Build a maps.google.com deep link — a place page, or a directions link. */
function gmapsDirUrl(from: GPlace | null, to: GPlace, mode: GTravelMode): string {
  const modeParam: Record<GTravelMode, string> = { DRIVE: 'driving', WALK: 'walking', BICYCLE: 'bicycling', TRANSIT: 'transit' }
  const dest = `${to.lat},${to.lon}`
  const params = new URLSearchParams({ api: '1', destination: dest, travelmode: modeParam[mode] })
  if (to.id) params.set('destination_place_id', to.id.replace(/^places\//, ''))
  if (from) params.set('origin', `${from.lat},${from.lon}`)
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

const MODE_ICONS: { mode: GTravelMode; Icon: typeof Car; label: string }[] = [
  { mode: 'DRIVE', Icon: Car, label: 'Drive' },
  { mode: 'WALK', Icon: Footprints, label: 'Walk' },
  { mode: 'BICYCLE', Icon: Bike, label: 'Cycle' },
  { mode: 'TRANSIT', Icon: Train, label: 'Transit' },
]

function GmapsPanel({ isMobile, configured, onClose }: { isMobile: boolean; configured: boolean | null; onClose: () => void }) {
  const {
    gmapsQuery, gmapsResults, gmapsSelectedPlaceId, gmapsSearching, gmapsError,
    gmapsSuggestions, gmapsSuggesting,
    gmapsRouteFrom, gmapsRouteTo, gmapsMode, gmapsRoutes, gmapsSelectedRoute, gmapsRouting,
    setGmapsQuery, searchGmaps, autocompleteGmaps, pickSuggestion, clearSuggestions,
    selectPlace, setRouteFrom, setRouteTo, setGmapsMode,
    computeDirections, selectRoute, clearDirections, setGmapsKey,
  } = useMapStore()
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  const doSearch = () => {
    clearSuggestions()
    const c = mapController.center?.()
    void searchGmaps(gmapsQuery, c ? { lat: c.lat, lon: c.lon } : undefined)
  }

  // debounced type-ahead as the query changes
  useEffect(() => {
    const q = gmapsQuery.trim()
    if (q.length < 2) { clearSuggestions(); return }
    const t = setTimeout(() => {
      const c = mapController.center?.()
      void autocompleteGmaps(q, c ? { lat: c.lat, lon: c.lon } : undefined)
    }, 250)
    return () => clearTimeout(t)
  }, [gmapsQuery, autocompleteGmaps, clearSuggestions])

  if (configured === false) {
    return (
      <div className="absolute top-12 left-2 z-10 w-80 rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium flex items-center gap-1"><Search size={14} /> Google Maps</span>
          <button onClick={onClose}><X size={14} /></button>
        </div>
        <p className="text-text-tertiary text-xs mb-2">
          Needs a Google Maps Platform API key with <b>Places API (New)</b> + <b>Routes API</b> enabled and billing on.
        </p>
        <input className="w-full mb-2 rounded bg-surface-1 border border-border px-2 py-1 font-mono text-xs"
          placeholder="AIza…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        {gmapsError && <p className="text-red-400 text-xs mb-2">{gmapsError}</p>}
        <button disabled={savingKey || !keyInput.trim()}
          onClick={async () => { setSavingKey(true); try { await setGmapsKey(keyInput.trim()) } finally { setSavingKey(false) } }}
          className="w-full rounded bg-blue-600 hover:bg-blue-500 py-1 disabled:opacity-50">
          {savingKey ? 'Saving…' : 'Save key'}
        </button>
      </div>
    )
  }

  return (
    <div className="absolute top-12 left-2 z-10 w-80 max-h-[80%] overflow-y-auto rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium flex items-center gap-1"><Search size={14} /> Google Maps</span>
        <button onClick={onClose}><X size={14} /></button>
      </div>

      {/* search box */}
      <div className="relative mb-2">
        <div className="flex items-center gap-1 rounded bg-surface-1 border border-border px-2 py-1">
          <Search size={13} className="text-text-tertiary shrink-0" />
          <input autoFocus className="flex-1 bg-transparent outline-none" placeholder="Search places…"
            value={gmapsQuery} onChange={(e) => setGmapsQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch()
              else if (e.key === 'Escape') clearSuggestions()
            }} />
          {(gmapsSearching || gmapsSuggesting) && <Loader2 size={13} className="animate-spin text-text-tertiary" />}
        </div>
        {/* type-ahead suggestions */}
        {gmapsSuggestions.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full rounded border border-border bg-surface-0 shadow-xl overflow-hidden">
            {gmapsSuggestions.map((s) => (
              <li key={s.placeId}>
                <button onClick={() => void pickSuggestion(s.placeId)}
                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-surface-2 flex items-start gap-1.5">
                  <MapPin size={12} className="text-text-tertiary shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    <span className="font-medium">{s.mainText}</span>
                    {s.secondaryText && <span className="text-text-tertiary">{`  ${s.secondaryText}`}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {gmapsError && <p className="text-red-400 text-xs mb-2">{gmapsError}</p>}

      {/* results */}
      {gmapsResults.length > 0 && (
        <ul className="space-y-1 mb-2">
          {gmapsResults.map((p) => (
            <li key={p.id}>
              <button onClick={() => selectPlace(p.id)}
                className={`w-full text-left rounded px-2 py-1 text-xs hover:bg-surface-2 ${p.id === gmapsSelectedPlaceId ? 'bg-surface-2' : ''}`}>
                <div className="font-medium">{p.name}</div>
                {p.address && <div className="text-text-tertiary truncate">{p.address}</div>}
                <div className="flex items-center gap-2 text-text-tertiary mt-0.5">
                  {p.rating != null && <span>★ {p.rating}{p.userRatingCount ? ` (${p.userRatingCount})` : ''}</span>}
                </div>
              </button>
              {p.id === gmapsSelectedPlaceId && (
                <div className="flex flex-wrap gap-2 px-2 py-1 text-xs">
                  <a href={p.googleMapsUri || gmapsDirUrl(null, p, gmapsMode)} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-400 hover:underline">
                    <ExternalLink size={11} /> Open in Google Maps
                  </a>
                  {!isMobile && (
                    <>
                      <button onClick={() => setRouteFrom(p)} className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary">
                        <Locate size={11} /> From here
                      </button>
                      <button onClick={() => setRouteTo(p)} className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary">
                        <Navigation size={11} /> Directions to
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* directions (desktop only — mobile opens the Google Maps app) */}
      {!isMobile && (gmapsRouteFrom || gmapsRouteTo) && (
        <div className="border-t border-border pt-2 mt-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium flex items-center gap-1"><Navigation size={12} /> Directions</span>
            <button onClick={clearDirections} className="text-text-tertiary hover:text-text-primary"><X size={12} /></button>
          </div>
          <div className="text-xs space-y-0.5 mb-2">
            <div className="flex items-center gap-1"><span className="text-text-tertiary w-8">From</span><span className="truncate">{gmapsRouteFrom?.name ?? '—'}</span></div>
            <div className="flex items-center gap-1"><span className="text-text-tertiary w-8">To</span><span className="truncate">{gmapsRouteTo?.name ?? '—'}</span></div>
          </div>
          {/* travel mode */}
          <div className="flex gap-1 mb-2">
            {MODE_ICONS.map(({ mode, Icon, label }) => (
              <button key={mode} onClick={() => setGmapsMode(mode)} title={label}
                className={`flex-1 flex items-center justify-center rounded py-1 border border-border ${gmapsMode === mode ? 'bg-blue-600 border-blue-600' : 'bg-surface-1 hover:bg-surface-2'}`}>
                <Icon size={14} />
              </button>
            ))}
          </div>
          <button disabled={!gmapsRouteFrom || !gmapsRouteTo || gmapsRouting}
            onClick={() => void computeDirections()}
            className="w-full rounded bg-blue-600 hover:bg-blue-500 py-1 text-xs disabled:opacity-50 mb-2">
            {gmapsRouting ? 'Routing…' : 'Get directions'}
          </button>
          {/* routes */}
          {gmapsRoutes.length > 0 && (
            <ul className="space-y-1">
              {gmapsRoutes.map((r, i) => (
                <li key={i}>
                  <button onClick={() => selectRoute(i)}
                    className={`w-full text-left rounded px-2 py-1 text-xs hover:bg-surface-2 ${i === gmapsSelectedRoute ? 'bg-surface-2 border-l-2 border-blue-500' : 'border-l-2 border-transparent'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{fmtDuration(r.durationSec)}</span>
                      <span className="text-text-tertiary">{fmtDistance(r.distanceMeters)}</span>
                    </div>
                    {r.description && <div className="text-text-tertiary truncate">{r.description}</div>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {gmapsRouteFrom && gmapsRouteTo && (
            <a href={gmapsDirUrl(gmapsRouteFrom, gmapsRouteTo, gmapsMode)} target="_blank" rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400 hover:underline">
              <ExternalLink size={11} /> Open route in Google Maps
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function PlaceDetailPanel({ place, isMobile, onClose }: { place: GPlace; isMobile: boolean; onClose: () => void }) {
  const { gmapsMode, setRouteFrom, setRouteTo } = useMapStore()
  return (
    <div className="absolute top-2 right-14 z-10 w-72 rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-start justify-between mb-1 gap-2">
        <div className="font-medium leading-tight">{place.name}</div>
        <button onClick={onClose}><X size={14} /></button>
      </div>
      {place.address && <div className="text-text-tertiary text-xs mb-2">{place.address}</div>}
      {place.rating != null && (
        <div className="text-xs text-text-secondary mb-2">★ {place.rating}{place.userRatingCount ? ` · ${place.userRatingCount} reviews` : ''}</div>
      )}
      <div className="flex flex-wrap gap-2 text-xs">
        <a href={place.googleMapsUri || gmapsDirUrl(null, place, gmapsMode)} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-blue-400 hover:underline">
          <ExternalLink size={11} /> Open in Google Maps
        </a>
        {!isMobile && (
          <>
            <button onClick={() => setRouteFrom(place)} className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary">
              <Locate size={11} /> From here
            </button>
            <button onClick={() => setRouteTo(place)} className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary">
              <Navigation size={11} /> Directions to
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function formatEventTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function MeetupEventPanel({ event, onClose }: { event: MeetupEvent; onClose: () => void }) {
  const d = event.detail
  const venueLine = [event.venueName, event.venueCity].filter(Boolean).join(', ')
  return (
    <div className="absolute top-2 right-14 z-10 w-80 max-h-[80%] overflow-y-auto rounded border border-border bg-surface-0 p-3 text-sm shadow-xl">
      <div className="flex items-start justify-between mb-1 gap-2">
        <div>
          <div className="font-medium leading-tight">{event.title}</div>
          {event.groupName && <div className="text-text-tertiary text-xs">{event.groupName}</div>}
        </div>
        <button onClick={onClose}><X size={14} /></button>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-secondary mb-2">
        <Calendar size={12} className="text-text-tertiary" />
        <span>{formatEventTime(event.dateTime)}</span>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-text-secondary mb-2">
        {event.going > 0 && <span className="flex items-center gap-1"><Users size={11} /> {event.going} going</span>}
        {event.eventType === 'ONLINE' && <span className="text-blue-400">online</span>}
        {event.eventType === 'HYBRID' && <span className="text-amber-400">hybrid</span>}
      </div>
      {venueLine && (
        <div className="text-xs text-text-tertiary mb-2 flex items-start gap-1">
          <MapPin size={11} className="mt-0.5 shrink-0" />
          <span>{venueLine}{event.venueAddress ? ` · ${event.venueAddress}` : ''}</span>
        </div>
      )}
      {!d ? (
        <div className="text-text-tertiary text-xs flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> loading detail…</div>
      ) : (
        d.description && <div className="text-xs text-text-secondary whitespace-pre-line line-clamp-[12] mb-2">{d.description}</div>
      )}
      <a
        href={event.eventUrl} target="_blank" rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
      >
        <Calendar size={11} /> open on meetup.com
      </a>
    </div>
  )
}
