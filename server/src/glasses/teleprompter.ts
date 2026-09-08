// Teleprompter session — the hub half of the G1's NATIVE teleprompter (PUT 0x09,
// docs/g1-protocol.md §20). The glasses hold ONE 512-byte text buffer and never
// scroll a longer text on their own, so the hub keeps the whole script, cuts it
// into 5-line pages and pushes a page per touchbar tap: right single-tap = next,
// left single-tap = previous. A double-tap (0xF5 0x00) means the glasses left the
// feature themselves — the session ends without another write. While a session
// is active the head-tilt HUD must stay quiet (a 0x4E push would fight the
// teleprompter screen) — `isActive()` is what wireHud consults.

import type { GlassesHub, GlassesNavAck, GlassesTouchFrame } from '../glasses-hub.js'

export const LINES_PER_PAGE = 5
/**
 * Wrap width in characters. The lens fits 41 em-dashes (§6); the font is
 * proportional so ordinary prose at 38 chars stays inside the width with margin —
 * a wrapped line would push the page's last row off-screen.
 */
export const WRAP_WIDTH = 38
/** Firmware text buffer (§20). A 5×38 page is ~200 B, so this only bites on CJK/emoji. */
export const PAGE_MAX_BYTES = 0x200

const TOUCH_DOUBLE_TAP = 0x00
const TOUCH_SINGLE_TAP = 0x01

/** Greedy word-wrap of one paragraph line; words longer than `width` are hard-cut. */
export function wrapLine(line: string, width: number = WRAP_WIDTH): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const out: string[] = []
  let cur = ''
  for (let w of words) {
    while (w.length > width) {
      if (cur) { out.push(cur); cur = '' }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Script → pages of at most `lines` display rows, each row ≤ `width` chars.
 * Blank source lines are kept as blank rows (paragraph breaks) but a page never
 * starts with one, and runs of blanks collapse to a single row. Every page is
 * also capped at PAGE_MAX_BYTES of UTF-8 — a row that would overflow starts a
 * new page.
 */
export function paginate(text: string, lines: number = LINES_PER_PAGE, width: number = WRAP_WIDTH): string[] {
  const rows: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') { if (rows.length && rows[rows.length - 1] !== '') rows.push(''); continue }
    rows.push(...wrapLine(raw, width))
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  const pages: string[] = []
  let cur: string[] = []
  let curBytes = 0
  const flush = () => { if (cur.length) { pages.push(cur.join('\n')); cur = []; curBytes = 0 } }
  for (const row of rows) {
    if (cur.length === 0 && row === '') continue
    const bytes = Buffer.byteLength(row, 'utf8') + (cur.length ? 1 : 0)
    if (cur.length >= lines || curBytes + bytes > PAGE_MAX_BYTES) flush()
    if (cur.length === 0 && row === '') continue
    cur.push(row)
    curBytes += bytes
  }
  flush()
  return pages
}

export interface TeleprompterStatus {
  active: boolean
  page: number
  pages: number
  title: string | null
}

export interface TeleprompterOpts {
  log: (msg: string) => void
  /** Injectable for tests. */
  linesPerPage?: number
  width?: number
}

export class TeleprompterController {
  private pages: string[] = []
  private index = 0
  private active = false
  private title: string | null = null
  private multipart = false
  private readonly unsubTouch: () => void

  constructor(private readonly hub: Pick<GlassesHub, 'teleprompterShow' | 'teleprompterExit' | 'onTouch'>, private readonly opts: TeleprompterOpts) {
    this.unsubTouch = hub.onTouch((f) => this.onTouch(f))
  }

  isActive(): boolean { return this.active }

  status(): TeleprompterStatus {
    return { active: this.active, page: this.active ? this.index + 1 : 0, pages: this.pages.length, title: this.title }
  }

  /** Cut `text` into pages and show the first one (opens the teleprompter app). */
  async start(text: string, o: { title?: string; multipart?: boolean } = {}): Promise<TeleprompterStatus & { ack: GlassesNavAck }> {
    const pages = paginate(text, this.opts.linesPerPage, this.opts.width)
    if (pages.length === 0) throw new Error('nothing to show — the text is empty')
    this.pages = pages
    this.index = 0
    this.title = o.title ?? null
    this.multipart = !!o.multipart
    const ack = await this.hub.teleprompterShow(pages[0]!, true, this.multipart)
    this.active = ack.ok
    if (!ack.ok) this.opts.log(`[glasses] teleprompter init refused: ${ack.error ?? `status ${ack.status}`}`)
    return { ...this.status(), ack }
  }

  async goto(index: number): Promise<TeleprompterStatus & { ack: GlassesNavAck }> {
    if (!this.active) throw new Error('no teleprompter session')
    const clamped = Math.max(0, Math.min(this.pages.length - 1, index))
    const ack = await this.hub.teleprompterShow(this.pages[clamped]!, false, this.multipart)
    if (ack.ok) this.index = clamped
    else this.opts.log(`[glasses] teleprompter page ${clamped + 1} refused: ${ack.error ?? `status ${ack.status}`}`)
    return { ...this.status(), ack }
  }

  next() { return this.goto(this.index + 1) }
  prev() { return this.goto(this.index - 1) }

  /** Leave the teleprompter app; safe to call when idle. */
  async stop(): Promise<TeleprompterStatus & { ack: GlassesNavAck | null }> {
    const was = this.active
    this.active = false
    const ack = was ? await this.hub.teleprompterExit() : null
    return { ...this.status(), ack }
  }

  /** The glasses exited on their own (double-tap) — forget the session, write nothing. */
  private endedByGlasses(): void {
    if (!this.active) return
    this.active = false
    this.opts.log(`[glasses] teleprompter ended by the glasses (double-tap) at page ${this.index + 1}/${this.pages.length}`)
  }

  private onTouch(f: GlassesTouchFrame): void {
    if (!this.active) return
    if (f.subcmd === TOUCH_DOUBLE_TAP) { this.endedByGlasses(); return }
    if (f.subcmd !== TOUCH_SINGLE_TAP) return
    const target = f.arm === 'right' ? this.index + 1 : this.index - 1
    if (target < 0 || target >= this.pages.length) return
    this.goto(target).catch((err) => this.opts.log(`[glasses] teleprompter tap page failed: ${(err as Error).message}`))
  }

  dispose(): void { this.unsubTouch() }
}
