import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeEventFrame, parseDot, parseIdChange, renderPageSvg, parsePageSvg,
  EVT_Dot, EVT_IdChange,
  type PenPageDoc,
} from '../pen/page-codec.js'
import { PenPageAssembler, pageRelPath } from '../pen/page-assembler.js'
import { PenHub } from '../pen-hub.js'
import { NoteStore } from '../notes.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A live dot: X=11 fx=86 → x=11.86, Y=40 fy=61 → y=40.61, force=31, timeDelta=5.
const DOT_BODY = '6c0a0000051f000b002800563d'
// IdChange: owner=27, section=3, note=727 (0x2d7), page=1.
const IDCHANGE_BODY = '6b0d00001b000003d702000001000000'

describe('page-codec', () => {
  it('decodes an event frame body into cmd + data slice', () => {
    const ev = decodeEventFrame(DOT_BODY)!
    expect(ev.cmd).toBe(EVT_Dot)
    expect(ev.data.length).toBe(10)
  })

  it('decodes a dot with fractional Ncode coords', () => {
    const ev = decodeEventFrame(DOT_BODY)!
    const d = parseDot(ev.data)
    expect(d.x).toBeCloseTo(11.86, 5)
    expect(d.y).toBeCloseTo(40.61, 5)
    expect(d.force).toBe(31)
    expect(d.timeDelta).toBe(5)
  })

  it('decodes a page-address change', () => {
    const ev = decodeEventFrame(IDCHANGE_BODY)!
    expect(ev.cmd).toBe(EVT_IdChange)
    const a = parseIdChange(ev.data)
    expect(a).toEqual({ owner: 27, section: 3, note: 727, page: 1 })
  })

  it('round-trips strokes through SVG metadata', () => {
    const doc: PenPageDoc = {
      v: 1, section: 3, owner: 27, note: 727, page: 1, unit: 'ncode',
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      strokes: [{ dots: [{ x: 11.86, y: 40.61, force: 31, t: 5 }, { x: 12.5, y: 41, force: 40, t: 12 }] }],
      updatedAt: 1700000000000,
    }
    const svg = renderPageSvg(doc)
    expect(svg).toContain('<path')
    expect(svg).toContain('fill="#111"')
    expect(svg).toContain('<penpage>')
    const back = parsePageSvg(svg)!
    expect(back.note).toBe(727)
    expect(back.strokes[0]!.dots[0]!.x).toBeCloseTo(11.86, 5)
    // Fixed page rect anchored at the crop-margin offset (strokes well inside).
    expect(svg).toMatch(/viewBox="6\.00 5\.00 37\.00 60\.00"/)
  })
})

// In-memory NoteStore stand-in (the assembler only calls write + read).
class FakeNotes {
  files = new Map<string, string>()
  async write(rel: string, content: string): Promise<void> { this.files.set(rel, content) }
  async read(rel: string): Promise<string> {
    const v = this.files.get(rel)
    if (v === undefined) throw new Error('not found')
    return v
  }
}

describe('PenPageAssembler', () => {
  it('assembles a stroke into a page SVG + broadcasts, then appends on revisit', async () => {
    const notes = new FakeNotes()
    const events: { op: string; data: any }[] = []
    const asm = new PenPageAssembler(notes as any, (op, data) => events.push({ op, data }), () => 1700000000000)

    const idChange = decodeEventFrame(IDCHANGE_BODY)!
    const dot = decodeEventFrame(DOT_BODY)!

    asm.onFrame(idChange.cmd, idChange.data) // page 727/1
    asm.onFrame(0x69, Buffer.alloc(0))       // pen-down
    asm.onFrame(dot.cmd, dot.data)           // one dot
    asm.onFrame(0x6a, Buffer.alloc(0))       // pen-up → flush
    await asm.whenIdle()

    const rel = pageRelPath({ section: 3, owner: 27, note: 727, page: 1 })
    expect(rel).toBe('scratch/pen/727/page-1.svg')
    const svg = notes.files.get(rel)!
    expect(svg).toContain('<path')
    const doc = parsePageSvg(svg)!
    expect(doc.strokes).toHaveLength(1)

    expect(events.map((e) => e.op)).toContain('page_open')
    expect(events.map((e) => e.op)).toContain('stroke_delta')
    expect(events.map((e) => e.op)).toContain('page_saved')

    // Leave the page and come back: a second stroke must APPEND, not overwrite.
    const other = decodeEventFrame('6b0d00001b000003d702000002000000')! // page 2
    asm.onFrame(other.cmd, other.data)
    asm.onFrame(idChange.cmd, idChange.data) // back to page 1 (loads existing strokes)
    asm.onFrame(0x69, Buffer.alloc(0))
    asm.onFrame(dot.cmd, dot.data)
    asm.onFrame(0x6a, Buffer.alloc(0))
    await asm.whenIdle()

    const doc2 = parsePageSvg(notes.files.get(rel)!)!
    expect(doc2.strokes).toHaveLength(2) // appended, not clobbered
  })
})

describe('PenHub frame → vault wiring', () => {
  it('decodes a pen_frame off the WS and writes the page SVG to the vault', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'pen-vault-'))
    try {
      const events: string[] = []
      const hub = new PenHub(
        {} as any,
        () => {},
        null,
        new NoteStore(vault),
        { broadcast: (_s: string, op: string) => { events.push(op) } } as any,
      )
      const send = (hex: string) =>
        hub.handleMessage(null as any, { type: 'pen_frame', kind: 'dot', hex, ts: 1 })

      expect(send(IDCHANGE_BODY)).toBe(true) // page 727/1
      send('690000')                          // pen-down (no data)
      send(DOT_BODY)                          // one dot
      send('6a0000')                          // pen-up → flush

      const rel = pageRelPath({ section: 3, owner: 27, note: 727, page: 1 })
      const abs = join(vault, rel)
      for (let i = 0; i < 100 && !existsSync(abs); i++) await sleep(10)
      expect(existsSync(abs)).toBe(true)
      expect(readFileSync(abs, 'utf-8')).toContain('<penpage>')
      expect(events).toContain('page_saved')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })
})
