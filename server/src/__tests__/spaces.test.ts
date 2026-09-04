import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSpaces, spaceCwd, projectRepo } from '../spaces.js'
import { NoteStore } from '../notes.js'

const BOARD = `---
kanban-plugin: board
---

## Backlog

- [ ] Someday

## In Progress

- [ ] Working on it @eng ^bold-fox

## Under Review

- [ ] Ship the widget @eng ^teal-crab
- [ ] Unowned review card ^dry-owl

## Done

- [x] Old thing @eng ^ripe-koi
`

let dir: string | null = null
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

function vault(): NoteStore {
  dir = mkdtempSync(join(tmpdir(), 'spaces-test-'))
  return new NoteStore(dir)
}

describe('listSpaces review counts', () => {
  it('counts Under Review cards and collects their agentKeys', async () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects/widget'), { recursive: true })
    writeFileSync(join(dir!, 'projects/widget/board.md'), BOARD)
    const spaces = await listSpaces(store)
    const widget = spaces.find((s) => s.slug === 'widget')!
    expect(widget.reviewCount).toBe(2)
    expect(widget.reviewAgentKeys).toEqual(['eng'])
  })

  it('collects card owners across ALL columns, deduped (^lean-ibis)', async () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects/widget'), { recursive: true })
    writeFileSync(join(dir!, 'projects/widget/board.md'), BOARD)
    const spaces = await listSpaces(store)
    const widget = spaces.find((s) => s.slug === 'widget')!
    expect(widget.cardAgentKeys).toEqual(['eng'])
  })

  it('ships the review cards + the Done column title (^pale-tern)', async () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects/widget'), { recursive: true })
    writeFileSync(join(dir!, 'projects/widget/board.md'), BOARD)
    const spaces = await listSpaces(store)
    const widget = spaces.find((s) => s.slug === 'widget')!
    expect(widget.reviewCards).toEqual([
      { blockId: 'teal-crab', text: 'Ship the widget', agentKey: 'eng' },
      { blockId: 'dry-owl', text: 'Unowned review card', agentKey: null },
    ])
    expect(widget.doneColumn).toBe('Done')
  })

  it('doneColumn is null when the board has no Done-like column', async () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects/widget'), { recursive: true })
    writeFileSync(join(dir!, 'projects/widget/board.md'), BOARD.replace('## Done', '## Archive'))
    const spaces = await listSpaces(store)
    expect(spaces.find((s) => s.slug === 'widget')!.doneColumn).toBeNull()
  })

  it('zero for boardless projects and areas', async () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects/plain'), { recursive: true })
    writeFileSync(join(dir!, 'projects/plain/index.md'), '# Plain\n')
    const spaces = await listSpaces(store)
    const plain = spaces.find((s) => s.slug === 'plain')!
    expect(plain.reviewCount).toBe(0)
    expect(plain.reviewAgentKeys).toEqual([])
    expect(plain.reviewCards).toEqual([])
    expect(plain.doneColumn).toBeNull()
    expect(plain.cardAgentKeys).toEqual([])
  })
})

describe('spaceCwd — where a bound session runs (^spry-seal)', () => {
  it('a folder project → its vault project dir; a flat project → projects/', () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects', 'demovid'), { recursive: true })
    writeFileSync(join(dir!, 'projects', 'coaching.md'), '# Coaching\n')
    expect(spaceCwd(store.vaultPath, { project: 'demovid' })).toBe(join(dir!, 'projects', 'demovid'))
    expect(spaceCwd(store.vaultPath, { project: 'coaching' })).toBe(join(dir!, 'projects'))
    expect(spaceCwd(store.vaultPath, { project: 'never-heard-of' })).toBe(join(dir!, 'projects'))
  })
  it('an area → the vault root; no binding → null (caller falls back)', () => {
    const store = vault()
    expect(spaceCwd(store.vaultPath, { areas: ['life'] })).toBe(store.vaultPath)
    expect(spaceCwd(store.vaultPath, { areas: [] })).toBeNull()
    expect(spaceCwd(store.vaultPath, {})).toBeNull()
  })
  it('project wins over areas when both are set', () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects', 'p'), { recursive: true })
    expect(spaceCwd(store.vaultPath, { project: 'p', areas: ['life'] })).toBe(join(dir!, 'projects', 'p'))
  })
})

describe('projectRepo + listSpaces cwd/repo', () => {
  it('resolves the repo symlink target; null when absent or dangling', async () => {
    const store = vault()
    const code = mkdtempSync(join(tmpdir(), 'spaces-repo-'))
    try {
      for (const slug of ['demovid', 'plain', 'broken']) {
        mkdirSync(join(dir!, 'projects', slug), { recursive: true })
        writeFileSync(join(dir!, 'projects', slug, 'index.md'), `---\ntitle: ${slug}\n---\n`)
      }
      symlinkSync(code, join(dir!, 'projects', 'demovid', 'repo'))
      symlinkSync(join(code, 'nope'), join(dir!, 'projects', 'broken', 'repo'))
      expect(projectRepo(store.vaultPath, 'demovid')).toBe(realpathSync(code))
      expect(projectRepo(store.vaultPath, 'plain')).toBeNull()
      expect(projectRepo(store.vaultPath, 'broken')).toBeNull()

      const spaces = await listSpaces(store)
      const demovid = spaces.find((s) => s.slug === 'demovid')!
      expect(demovid.cwd).toBe(join(dir!, 'projects', 'demovid'))
      expect(demovid.repo).toBe(realpathSync(code))
      expect(spaces.find((s) => s.slug === 'plain')!.repo).toBeNull()
    } finally {
      rmSync(code, { recursive: true, force: true })
    }
  })
})
