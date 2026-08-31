import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { yamlScalar, unquoteYamlScalar, parseFrontmatter, stampFrontmatter } from '../blog.js'

// The whole point of yamlScalar is that a REAL yaml parser accepts what we
// write — our own hand-rolled parseFrontmatter is too forgiving to prove it
// (Eleventy is the consumer that actually breaks).
function yamlValue(key: string, raw: string): unknown {
  return (parseYaml(`${key}: ${raw}\n`) as Record<string, unknown>)[key]
}

const HOSTILE = [
  'Foo: bar',
  'Wait for it:',
  'Blast from the past: "Cult II: Federal Crime"',
  "Sainsbury's CLI",
  'Bruteforcing tailnet "fun names"',
  'true',
  'null',
  '2026',
  '0x10',
  '- dashed',
  '#hash',
  'a #b',
  ' padded ',
  '',
  'back\\slash: x',
  'two: lines\nhere',
  'tab:\there',
  '{braced}: x',
  '@at: sign',
  'plain title',
  '2026-06-08 10:00:00',
]

describe('yamlScalar', () => {
  it('emits something a real YAML parser reads back verbatim', () => {
    for (const s of HOSTILE) {
      expect(yamlValue('title', yamlScalar(s)), s).toBe(s)
    }
  })

  it('round-trips through unquoteYamlScalar', () => {
    for (const s of HOSTILE) expect(unquoteYamlScalar(yamlScalar(s)), s).toBe(s)
  })

  it('leaves already-safe values unquoted (no churn on existing posts)', () => {
    expect(yamlScalar('plain title')).toBe('plain title')
    expect(yamlScalar("Sainsbury's CLI")).toBe("Sainsbury's CLI")
    // colon-before-digit is not a mapping — existing date lines stay as-is
    expect(yamlScalar('2026-06-08 10:00:00')).toBe('2026-06-08 10:00:00')
  })

  it('passes non-strings through', () => {
    expect(yamlScalar(true)).toBe('true')
    expect(yamlScalar(false)).toBe('false')
    expect(yamlScalar(7)).toBe('7')
  })
})

describe('parseFrontmatter', () => {
  it('keeps an unmatched trailing quote as content', () => {
    const { fm } = parseFrontmatter('---\ntitle: Bruteforcing tailnet "fun names"\n---\n')
    expect(fm.title).toBe('Bruteforcing tailnet "fun names"')
  })

  it('unescapes double- and single-quoted scalars', () => {
    expect(parseFrontmatter('---\ntitle: "He said \\"hi\\": really"\n---\n').fm.title)
      .toBe('He said "hi": really')
    expect(parseFrontmatter(`---\ntitle: 'Blast: "Cult II" it''s'\n---\n`).fm.title)
      .toBe(`Blast: "Cult II" it's`)
  })

  it('does not bool-coerce a quoted value', () => {
    expect(parseFrontmatter('---\ntitle: "true"\n---\n').fm.title).toBe('true')
    expect(parseFrontmatter('---\npublic: true\n---\n').fm.public).toBe(true)
  })

  it('treats a quoted tags scalar as one tag', () => {
    expect(parseFrontmatter('---\ntags: "a, b"\n---\n').fm.tags).toEqual(['a, b'])
  })
})

describe('stampFrontmatter', () => {
  it('escapes a stamped title with a colon', () => {
    const out = stampFrontmatter('---\ntitle: Old\npublic: false\n---\nbody\n', { title: 'Foo: bar' })
    expect(out).toContain('title: "Foo: bar"')
    expect(parseFrontmatter(out).fm.title).toBe('Foo: bar')
    expect((parseYaml(out.split('---\n')[1]!) as Record<string, unknown>).title).toBe('Foo: bar')
  })

  it('leaves other keys and the body alone', () => {
    const out = stampFrontmatter('---\ntitle: Old\npublic: false\n---\nbody\n', { title: 'X: y' })
    expect(parseFrontmatter(out).fm.public).toBe(false)
    expect(out).toContain('body')
  })
})

describe('createDraft / createProject emit parseable YAML', () => {
  const NASTY = 'Bug: titles aren\'t escaped — "really"'

  it('createDraft (unhomed, project and area forms)', async () => {
    const { mkdtempSync, mkdirSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { NoteStore } = await import('../notes.js')
    const { createDraft } = await import('../blog.js')
    const dir = mkdtempSync(join(tmpdir(), 'blog-fm-'))
    mkdirSync(join(dir, 'log', 'drafts'), { recursive: true })
    mkdirSync(join(dir, 'projects', 'console', 'log', 'drafts'), { recursive: true })
    const store = new NoteStore(dir)
    try {
      for (const opts of [
        { title: NASTY },
        { title: NASTY, project: 'console' },
        { title: NASTY, area: 'ai' },
      ]) {
        const r = await createDraft(store, opts)
        expect(r.ok, JSON.stringify(opts)).toBe(true)
        const text = readFileSync(join(dir, r.path!), 'utf-8')
        const fmRaw = text.match(/^---\n([\s\S]*?)\n---\n/)![1]!
        const fm = parseYaml(fmRaw) as Record<string, unknown>
        expect(fm.title, JSON.stringify(opts)).toBe(NASTY)
        expect(parseFrontmatter(text).fm.title).toBe(NASTY)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createProject', async () => {
    const { mkdtempSync, mkdirSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { NoteStore } = await import('../notes.js')
    const { createProject } = await import('../blog.js')
    const dir = mkdtempSync(join(tmpdir(), 'blog-fm-'))
    mkdirSync(join(dir, 'projects'), { recursive: true })
    const store = new NoteStore(dir)
    try {
      const r = await createProject(store, { title: NASTY })
      expect(r.ok, r.error).toBe(true)
      const text = readFileSync(join(dir, r.path!), 'utf-8')
      const fm = parseYaml(text.match(/^---\n([\s\S]*?)\n---\n/)![1]!) as Record<string, unknown>
      expect(fm.title).toBe(NASTY)
      expect(fm.status).toBe('active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
