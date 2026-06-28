// Pure decode of live Neo-pen event frames + SVG (de)serialization for one
// notebook page. Mirrors android/.../pen/PenProtocol.kt (parseIdChange/parseDot).
// No Node deps beyond Buffer; unit-testable.

export const EVT_PenDown = 0x69
export const EVT_PenUp = 0x6a
export const EVT_IdChange = 0x6b
export const EVT_Dot = 0x6c

export interface PageAddr { section: number; owner: number; note: number; page: number }
export interface PenDot { x: number; y: number; force: number; t: number }
export interface PenStroke { dots: PenDot[] }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }
export interface PenPageDoc {
  v: 1
  section: number
  owner: number
  note: number
  page: number
  unit: 'ncode'
  bbox: BBox
  strokes: PenStroke[]
  updatedAt: number
}

const u16le = (b: Buffer, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u32le = (b: Buffer, o: number): number =>
  (((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0)

/**
 * Decode a forwarded event frame body (`cmd | len_lo | len_hi | data[len]`,
 * the unescaped body the APK sends as `pen_frame.hex`). Returns the cmd byte +
 * the event data slice (events have no result byte → data starts at offset 3).
 */
export function decodeEventFrame(hex: string): { cmd: number; data: Buffer } | null {
  let buf: Buffer
  try { buf = Buffer.from(hex, 'hex') } catch { return null }
  if (buf.length < 3) return null
  const cmd = buf[0]
  const len = u16le(buf, 1)
  const data = buf.subarray(3, Math.min(3 + len, buf.length))
  return { cmd, data }
}

/** 0x6B page-address (Ncode) change. */
export function parseIdChange(data: Buffer): PageAddr {
  const owner = (data[1] ?? 0) | ((data[2] ?? 0) << 8) | ((data[3] ?? 0) << 16)
  return { owner, section: data[4] ?? 0, note: u32le(data, 5), page: u32le(data, 9) }
}

/** 0x6C live dot. x = X + fx*0.01; `timeDelta` adds to the prior dot's timestamp. */
export function parseDot(data: Buffer): { x: number; y: number; force: number; timeDelta: number } {
  const X = u16le(data, 4)
  const Y = u16le(data, 6)
  const fx = data[8] ?? 0
  const fy = data[9] ?? 0
  return { x: X + fx * 0.01, y: Y + fy * 0.01, force: u16le(data, 2), timeDelta: data[1] ?? 0 }
}

// ---- SVG (de)serialization -------------------------------------------------

const SVG_SCALE = 12 // Ncode-units → px for width/height (hi-res for OCR; viewBox is in units)

// Fixed page rect in Ncode units so the canvas does NOT grow as you write. The
// Moleskine Pocket Cahier's writable Ncode area starts at a crop-margin OFFSET
// (~6,5), not the origin — anchoring the viewBox there keeps the margins even
// (a 0,0 origin left a ~15mm dead band on the left/top). Calibrated from
// four-corner test writing on notebook 727 (X≈7..42, Y≈6..64). Tune if a page clips.
export const NCODE_PAGE_X0 = 6
export const NCODE_PAGE_Y0 = 5
export const NCODE_PAGE_W = 37
export const NCODE_PAGE_H = 60

// Pressure → stroke width (Ncode units, full width). Observed force ≈ 1..300;
// FORCE_REF is a firm press. ~0.15u (0.36mm) light … 0.5u (1.2mm) heavy.
const FORCE_REF = 480
const W_MIN = 0.06
const W_MAX = 0.18
export function forceToWidth(force: number): number {
  const t = Math.max(0, Math.min(1, (force || 0) / FORCE_REF))
  return W_MIN + t * (W_MAX - W_MIN)
}

export function computeBBox(strokes: PenStroke[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) {
    for (const d of s.dots) {
      if (d.x < minX) minX = d.x
      if (d.y < minY) minY = d.y
      if (d.x > maxX) maxX = d.x
      if (d.y > maxY) maxY = d.y
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

/**
 * Variable-width filled outline ("ribbon") for one stroke — width tracks
 * per-dot pressure. One filled `<path>` per stroke keeps the DOM light vs.
 * per-segment lines. Single-dot strokes render as a filled circle.
 */
export function strokeRibbonPath(s: PenStroke): string {
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
    const nx = -ty // unit normal
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

/**
 * Render a page to an SVG: a fixed page-sized viewBox in Ncode units (stable
 * from the first stroke — it only expands if writing somehow exceeds the page,
 * never clipping), pressure-width ribbon `<path>`s, and the lossless
 * `PenPageDoc` embedded in `<metadata><penpage>…` (numeric JSON embeds raw).
 */
export function renderPageSvg(doc: PenPageDoc): string {
  const bb = computeBBox(doc.strokes)
  const pad = 0.5
  const x0 = Math.min(NCODE_PAGE_X0, bb.minX - pad)
  const y0 = Math.min(NCODE_PAGE_Y0, bb.minY - pad)
  const x1 = Math.max(NCODE_PAGE_X0 + NCODE_PAGE_W, bb.maxX + pad)
  const y1 = Math.max(NCODE_PAGE_Y0 + NCODE_PAGE_H, bb.maxY + pad)
  const w = x1 - x0
  const h = y1 - y0
  const meta = JSON.stringify({ ...doc, bbox: bb })
  const paths = doc.strokes
    .map((s) => strokeRibbonPath(s))
    .filter(Boolean)
    .map((d) => `<path d="${d}" fill="#111"/>`)
    .join('\n  ')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(2)} ${y0.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="${Math.round(w * SVG_SCALE)}" height="${Math.round(h * SVG_SCALE)}">`,
    `  <metadata><penpage>${meta}</penpage></metadata>`,
    `  ${paths}`,
    `</svg>`,
    '',
  ].join('\n')
}

/** Extract the embedded `PenPageDoc` from a page SVG (for re-render / append / OCR). */
export function parsePageSvg(svg: string): PenPageDoc | null {
  const m = svg.match(/<penpage>([\s\S]*?)<\/penpage>/)
  if (!m) return null
  try { return JSON.parse(m[1]) as PenPageDoc } catch { return null }
}
