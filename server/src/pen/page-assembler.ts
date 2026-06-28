// Assembles live pen events into per-Ncode-page SVG files in the notes vault,
// and broadcasts stroke deltas so the Notes tab can live-render the open page.
//
// Frames are processed strictly in order via a promise chain — onFrame() is
// fire-and-forget from the WS handler, but file I/O (load/flush) must not
// interleave with dot mutation.

import type { NoteStore } from '../notes.js'
import {
  EVT_PenDown, EVT_PenUp, EVT_IdChange, EVT_Dot,
  parseIdChange, parseDot, renderPageSvg, parsePageSvg,
  type PageAddr, type PenDot, type PenStroke, type PenPageDoc,
} from './page-codec.js'

export type PenBroadcast = (op: string, data: unknown) => void

export function pageRelPath(a: PageAddr): string {
  return `scratch/pen/${a.note}/page-${a.page}.svg`
}

function samePage(a: PageAddr, b: PageAddr): boolean {
  return a.section === b.section && a.owner === b.owner && a.note === b.note && a.page === b.page
}

export class PenPageAssembler {
  private page: PageAddr | null = null
  private strokes: PenStroke[] = []
  private open: PenDot[] | null = null
  private cumT = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly notes: NoteStore,
    private readonly broadcast: PenBroadcast,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Feed one decoded event frame (fire-and-forget; serialized internally). */
  onFrame(cmd: number, data: Buffer): void {
    // Copy: `data` is a subarray view of a Buffer that may be reused by the caller.
    const buf = Buffer.from(data)
    this.chain = this.chain.then(() => this.process(cmd, buf)).catch(() => {})
  }

  /** Resolves once every queued frame has been processed (test affordance). */
  whenIdle(): Promise<void> {
    return this.chain
  }

  private async process(cmd: number, data: Buffer): Promise<void> {
    switch (cmd) {
      case EVT_IdChange: {
        const addr = parseIdChange(data)
        if (!this.page || !samePage(this.page, addr)) {
          await this.flush() // persist the page we're leaving
          this.page = addr
          this.strokes = []
          this.open = null
          await this.loadExisting(addr) // merge prior strokes so we append, not overwrite
          this.broadcast('page_open', {
            section: addr.section, owner: addr.owner, note: addr.note, page: addr.page,
            relPath: pageRelPath(addr), strokes: this.strokes,
          })
        }
        break
      }
      case EVT_PenDown:
        this.open = []
        this.cumT = 0
        break
      case EVT_Dot: {
        if (!this.open) this.open = [] // tolerate a dot before pen-down
        const p = parseDot(data)
        this.cumT += p.timeDelta
        const dot: PenDot = { x: p.x, y: p.y, force: p.force, t: this.cumT }
        this.open.push(dot)
        if (this.page) {
          this.broadcast('stroke_delta', {
            section: this.page.section, owner: this.page.owner, note: this.page.note, page: this.page.page,
            dots: [dot],
          })
        }
        break
      }
      case EVT_PenUp: {
        if (this.open && this.open.length > 0) {
          this.strokes.push({ dots: this.open })
          if (this.page) {
            this.broadcast('stroke_end', {
              section: this.page.section, owner: this.page.owner, note: this.page.note, page: this.page.page,
              strokeIndex: this.strokes.length - 1,
            })
          }
          await this.flush()
        }
        this.open = null
        break
      }
    }
  }

  /** Build the SVG synchronously (snapshot), then write + broadcast page_saved. */
  private async flush(): Promise<void> {
    if (!this.page || this.strokes.length === 0) return
    const addr = this.page
    const doc: PenPageDoc = {
      v: 1,
      section: addr.section, owner: addr.owner, note: addr.note, page: addr.page,
      unit: 'ncode',
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, // recomputed inside renderPageSvg
      strokes: this.strokes,
      updatedAt: this.now(),
    }
    const rel = pageRelPath(addr)
    const svg = renderPageSvg(doc) // sync snapshot before any await
    try {
      await this.notes.write(rel, svg)
      this.broadcast('page_saved', {
        section: addr.section, owner: addr.owner, note: addr.note, page: addr.page, relPath: rel,
      })
    } catch {
      /* best effort — a failed write just means this page isn't persisted yet */
    }
  }

  /** Load an existing page's embedded strokes so a revisit appends, not overwrites. */
  private async loadExisting(addr: PageAddr): Promise<void> {
    try {
      const svg = await this.notes.read(pageRelPath(addr))
      const doc = parsePageSvg(svg)
      if (doc?.strokes?.length) this.strokes = doc.strokes
    } catch {
      /* no existing page file — start fresh */
    }
  }
}
