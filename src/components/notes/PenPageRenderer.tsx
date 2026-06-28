// Renders a live-streamed Neo-pen notebook page (scratch/pen/<note>/page-<n>.svg)
// inside the Notes editor pane. The saved SVG embeds the lossless strokes in
// <metadata><penpage>…; we parse those and draw them, then overlay live strokes
// pushed from the hub over SyncBus 'pen' (filtered to THIS page) so handwriting
// appears in near-real-time. Prev/next arrows walk sibling pages.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, PenLine } from 'lucide-react'
import { hubBus } from '@/sync-bus'
import { useNotesStore } from '@/store/notes'

interface Dot { x: number; y: number; force: number; t: number }
interface Stroke { dots: Dot[] }

/** Pull the embedded PenPageDoc strokes out of a page SVG. */
function parseStrokes(svg: string): Stroke[] {
  const m = svg.match(/<penpage>([\s\S]*?)<\/penpage>/)
  if (!m) return []
  try {
    const doc = JSON.parse(m[1]!)
    return Array.isArray(doc.strokes) ? (doc.strokes as Stroke[]) : []
  } catch {
    return []
  }
}

/** scratch/pen/<note>/page-<page>.svg → {note, page}. */
function addrFromPath(path: string): { note: number; page: number } | null {
  const m = path.match(/scratch\/pen\/(\d+)\/page-(\d+)\.svg$/)
  if (!m) return null
  return { note: parseInt(m[1]!, 10), page: parseInt(m[2]!, 10) }
}

// Kept in sync with server/src/pen/page-codec.ts — the hub renders the durable
// SVG with the same geometry; this draws the live overlay identically.
// Page rect anchored at the Ncode crop-margin offset (writable area starts ~6,5,
// not 0,0). Calibrated from four-corner test writing on notebook 727.
const NCODE_PAGE_X0 = 6
const NCODE_PAGE_Y0 = 5
const NCODE_PAGE_W = 37
const NCODE_PAGE_H = 60
const FORCE_REF = 480
const W_MIN = 0.06
const W_MAX = 0.18

function forceToWidth(force: number): number {
  const t = Math.max(0, Math.min(1, (force || 0) / FORCE_REF))
  return W_MIN + t * (W_MAX - W_MIN)
}

/** Fixed page rect (Ncode units) anchored at the crop offset; only expands if writing exceeds it. */
function pageBox(strokes: Stroke[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) {
    for (const d of s.dots) {
      if (d.x < minX) minX = d.x
      if (d.y < minY) minY = d.y
      if (d.x > maxX) maxX = d.x
      if (d.y > maxY) maxY = d.y
    }
  }
  const pad = 0.5
  const x0 = Math.min(NCODE_PAGE_X0, (Number.isFinite(minX) ? minX : NCODE_PAGE_X0) - pad)
  const y0 = Math.min(NCODE_PAGE_Y0, (Number.isFinite(minY) ? minY : NCODE_PAGE_Y0) - pad)
  const x1 = Math.max(NCODE_PAGE_X0 + NCODE_PAGE_W, (Number.isFinite(maxX) ? maxX : 0) + pad)
  const y1 = Math.max(NCODE_PAGE_Y0 + NCODE_PAGE_H, (Number.isFinite(maxY) ? maxY : 0) + pad)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Variable-width filled outline ("ribbon") — stroke width tracks pen pressure. */
function strokeRibbonPath(s: Stroke): string {
  const p = s.dots
  if (p.length === 0) return ''
  if (p.length === 1) {
    const r = forceToWidth(p[0]!.force) / 2
    const { x, y } = p[0]!
    return `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0Z`
  }
  const n = p.length
  const left: string[] = []
  const right: string[] = []
  for (let i = 0; i < n; i++) {
    const a = p[Math.max(0, i - 1)]!
    const b = p[Math.min(n - 1, i + 1)]!
    let tx = b.x - a.x
    let ty = b.y - a.y
    const len = Math.hypot(tx, ty) || 1
    tx /= len; ty /= len
    const nx = -ty
    const ny = tx
    const w = forceToWidth(p[i]!.force) / 2
    left.push(`${(p[i]!.x + nx * w).toFixed(2)} ${(p[i]!.y + ny * w).toFixed(2)}`)
    right.push(`${(p[i]!.x - nx * w).toFixed(2)} ${(p[i]!.y - ny * w).toFixed(2)}`)
  }
  let d = `M${left[0]}`
  for (let i = 1; i < n; i++) d += `L${left[i]}`
  for (let i = n - 1; i >= 0; i--) d += `L${right[i]}`
  return d + 'Z'
}

export function PenPageRenderer({ filePath, content }: { filePath: string; content: string }) {
  const addr = useMemo(() => addrFromPath(filePath), [filePath])
  const [base, setBase] = useState<Stroke[]>(() => parseStrokes(content))
  const [live, setLive] = useState<Stroke[]>([])
  const liveRef = useRef<Stroke[]>([])
  const rafRef = useRef<number | null>(null)
  const nextPage = useNotesStore((s) => s.nextPageInFolder)
  const prevPage = useNotesStore((s) => s.prevPageInFolder)

  // Whenever the open page changes, seed from the cached tab content immediately
  // (no flash), then fetch the FRESHEST durable SVG. The open-tab cache is
  // captured when the tab first opens and doesn't update as more strokes are
  // written — so re-opening a page (auto-open on tab switch, or switching notes)
  // would otherwise show a stale page until you write again.
  useEffect(() => {
    setBase(parseStrokes(content))
    liveRef.current = []
    setLive([])
    let cancelled = false
    const adapter = useNotesStore.getState().adapter
    adapter?.readFile(filePath)
      .then((svg) => { if (!cancelled) setBase(parseStrokes(svg)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [content, filePath])

  // Live overlay — subscribe to hub pen events for THIS page only. The hub
  // durably writes the SVG on pen-up; until that arrives we draw the in-flight
  // strokes ourselves so there's no lag.
  useEffect(() => {
    if (!addr) return
    const mine = (d: unknown): boolean => {
      const o = d as { note?: number; page?: number } | null
      return !!o && o.note === addr.note && o.page === addr.page
    }
    const commit = () => {
      rafRef.current = null
      setLive(liveRef.current.map((s) => ({ dots: s.dots.slice() })))
    }
    const schedule = () => { if (rafRef.current == null) rafRef.current = requestAnimationFrame(commit) }

    const offDelta = hubBus.on('pen', 'stroke_delta', (d) => {
      if (!mine(d)) return
      const dots = ((d as { dots?: Dot[] }).dots) ?? []
      let cur = liveRef.current[liveRef.current.length - 1]
      if (!cur) { cur = { dots: [] }; liveRef.current.push(cur) }
      cur.dots.push(...dots)
      schedule()
    })
    const offEnd = hubBus.on('pen', 'stroke_end', (d) => {
      if (!mine(d)) return
      liveRef.current.push({ dots: [] }) // next pen-down starts a fresh stroke
    })
    const offOpen = hubBus.on('pen', 'page_open', (d) => {
      if (!mine(d)) return
      const strokes = (d as { strokes?: Stroke[] }).strokes
      if (Array.isArray(strokes)) setBase(strokes)
      liveRef.current = []
      setLive([])
    })
    // On a durable save, the saved SVG now includes what we drew live → re-read
    // it and drop the overlay (seamless: base updates and live clears together).
    const offSaved = hubBus.on('pen', 'page_saved', (d) => {
      if (!mine(d)) return
      const adapter = useNotesStore.getState().adapter
      adapter?.readFile(filePath).then((svg) => {
        setBase(parseStrokes(svg))
        liveRef.current = []
        setLive([])
      }).catch(() => {})
    })

    return () => {
      offDelta(); offEnd(); offOpen(); offSaved()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [addr, filePath])

  const all = useMemo(() => [...base, ...live], [base, live])
  const bb = useMemo(() => pageBox(all), [all])
  const empty = all.every((s) => s.dots.length === 0)

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full bg-surface-0">
      <div className="flex items-center justify-between px-3 py-1 border-b border-border flex-shrink-0">
        <button
          onClick={() => void prevPage()}
          className="p-1 rounded-sm text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors"
          title="Previous page"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <PenLine size={11} />
          {addr ? `notebook ${addr.note} · page ${addr.page}` : filePath}
        </span>
        <button
          onClick={() => void nextPage()}
          className="p-1 rounded-sm text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors"
          title="Next page"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4">
        {empty ? (
          <span className="text-[11px] text-text-tertiary">Waiting for strokes — start writing on this page.</span>
        ) : (
          <svg
            viewBox={`${bb.x.toFixed(2)} ${bb.y.toFixed(2)} ${bb.w.toFixed(2)} ${bb.h.toFixed(2)}`}
            preserveAspectRatio="xMidYMid meet"
            className="max-w-full max-h-full shadow-sm"
            style={{ width: '100%', height: '100%' }}
          >
            <rect x={bb.x} y={bb.y} width={bb.w} height={bb.h} fill="#faf9f5" />
            {base.map((s, i) => (
              <path key={`b${i}`} d={strokeRibbonPath(s)} fill="#111" />
            ))}
            {live.map((s, i) => (
              <path key={`l${i}`} d={strokeRibbonPath(s)} fill="#111" />
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}
