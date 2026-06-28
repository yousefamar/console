// Agent-authored map layers. Other agents PUSH GeoJSON layers (pins/lines/
// polygons) via `con map layer upsert`; the Map tab renders them as toggle-able
// overlays. Layers can be multi-MB (e.g. isochrone polygons), so the GeoJSON
// lives on disk and is fetched by the client over HTTP — the SyncBus only ever
// carries the lightweight INDEX (metadata + style + bbox).
//
// Storage: ~/.config/console/map-layers/<group>/<name>.geojson + index.json.
// Slugs are namespaced (`where-to-move/towns`) so a group toggles together.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const DIR = join(homedir(), '.config', 'console', 'map-layers')
const INDEX = join(DIR, 'index.json')

export interface LayerStyle {
  /** default point colour/size when a feature has no `_color`/`_size`. */
  color?: string
  size?: number
  /** polygon fill + stroke. */
  fillColor?: string
  fillOpacity?: number
  strokeColor?: string
  strokeWidth?: number
  /** line styling. */
  lineColor?: string
  lineWidth?: number
  /** animate line dashes (marching ants) — used by flight arcs. */
  animated?: boolean
  /** ordered popup fields; bare key or {key,label}. Omit → show all props. */
  popup?: Array<string | { key: string; label?: string }>
}

export interface LayerMeta {
  slug: string
  group: string
  name: string
  geometryTypes: string[]
  featureCount: number
  /** [west, south, east, north] or null if no coordinates. */
  bbox: [number, number, number, number] | null
  style: LayerStyle
  fit: boolean
  updatedAt: number
  updatedBy?: string
}

function sanitizeSlug(slug: string): string {
  return slug
    .split('/')
    .map((s) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function geojsonPath(slug: string): string {
  return join(DIR, ...slug.split('/')) + '.geojson'
}

/** Walk a GeoJSON value, returning bbox + feature count + geometry types. */
export function inspectGeojson(gj: unknown): {
  bbox: [number, number, number, number] | null
  featureCount: number
  geometryTypes: string[]
} {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  let count = 0
  const types = new Set<string>()

  const walkCoords = (c: unknown): void => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [lon, lat] = c as number[]
      if (lon < w) w = lon
      if (lon > e) e = lon
      if (lat < s) s = lat
      if (lat > n) n = lat
      return
    }
    for (const x of c) walkCoords(x)
  }
  const walkGeom = (g: { type?: string; coordinates?: unknown; geometries?: unknown[] } | null): void => {
    if (!g) return
    if (g.type) types.add(g.type)
    if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) g.geometries.forEach((x) => walkGeom(x as never))
    else if (g.coordinates) walkCoords(g.coordinates)
  }

  const obj = gj as { type?: string; features?: Array<{ geometry?: unknown }>; geometry?: unknown }
  if (obj?.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    count = obj.features.length
    for (const f of obj.features) walkGeom((f?.geometry ?? null) as never)
  } else if (obj?.type === 'Feature') {
    count = 1
    walkGeom((obj.geometry ?? null) as never)
  } else if (obj?.type) {
    count = 1
    walkGeom(obj as never)
  }

  const bbox: [number, number, number, number] | null = Number.isFinite(w) ? [w, s, e, n] : null
  return { bbox, featureCount: count, geometryTypes: [...types] }
}

export class MapLayerStore {
  private metas = new Map<string, LayerMeta>()

  constructor() {
    this.load()
  }

  upsert(rawSlug: string, geojson: unknown, opts: { style?: LayerStyle; fit?: boolean; updatedBy?: string } = {}): LayerMeta {
    const slug = sanitizeSlug(rawSlug)
    if (!slug) throw new Error('invalid layer slug')
    if (!geojson || typeof geojson !== 'object') throw new Error('geojson must be an object')

    const { bbox, featureCount, geometryTypes } = inspectGeojson(geojson)
    const file = geojsonPath(slug)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(geojson))
    renameSync(tmp, file)

    const cut = slug.lastIndexOf('/')
    const meta: LayerMeta = {
      slug,
      group: cut >= 0 ? slug.slice(0, cut) : '',
      name: cut >= 0 ? slug.slice(cut + 1) : slug,
      geometryTypes,
      featureCount,
      bbox,
      style: opts.style ?? this.metas.get(slug)?.style ?? {},
      fit: opts.fit ?? false,
      updatedAt: Date.now(),
      updatedBy: opts.updatedBy,
    }
    this.metas.set(slug, meta)
    this.saveIndex()
    return meta
  }

  getGeojson(slug: string): unknown | null {
    const file = geojsonPath(sanitizeSlug(slug))
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  getMeta(slug: string): LayerMeta | undefined {
    return this.metas.get(sanitizeSlug(slug))
  }

  list(): LayerMeta[] {
    return [...this.metas.values()].sort((a, b) => a.slug.localeCompare(b.slug))
  }

  remove(slug: string): boolean {
    const s = sanitizeSlug(slug)
    if (!this.metas.has(s)) return false
    this.metas.delete(s)
    rmSync(geojsonPath(s), { force: true })
    this.saveIndex()
    return true
  }

  /** Remove every layer, or every layer under a group prefix. */
  clear(group?: string): number {
    const prefix = group ? sanitizeSlug(group) : ''
    let removed = 0
    for (const slug of [...this.metas.keys()]) {
      if (!prefix || slug === prefix || slug.startsWith(prefix + '/')) {
        this.remove(slug)
        removed++
      }
    }
    return removed
  }

  private load(): void {
    try {
      if (existsSync(INDEX)) {
        const arr = JSON.parse(readFileSync(INDEX, 'utf8')) as LayerMeta[]
        for (const m of arr) if (m?.slug) this.metas.set(m.slug, m)
      }
    } catch {
      // corrupt index — start empty
    }
  }

  private saveIndex(): void {
    mkdirSync(DIR, { recursive: true })
    const tmp = `${INDEX}.tmp`
    writeFileSync(tmp, JSON.stringify(this.list(), null, 2))
    renameSync(tmp, INDEX)
  }
}
