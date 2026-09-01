import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoteStore } from '../notes.js'
import { BoardOps, resolveBoardPath, findCardByQuery } from '../kanban/board-ops.js'
import { parseBoard } from '../kanban/board.js'

const BOARD = `---
kanban-plugin: board
---

## Backlog

- [ ] First idea
- [ ] Second idea @eng ^aa11bb
	- existing note

## In Progress

- [ ] Going @eng ^cc22dd

## Done

- [x] Old thing @eng ^ee33ff
`

let dir: string
let store: NoteStore
let ops: BoardOps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-ops-'))
  mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
  writeFileSync(join(dir, 'projects', 'demo', 'board.md'), BOARD)
  store = new NoteStore(dir)
  ops = new BoardOps(store)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const onDisk = () => readFileSync(join(dir, 'projects', 'demo', 'board.md'), 'utf-8')

describe('resolveBoardPath', () => {
  it('resolves a slug to board.md, and a direct path to itself', async () => {
    expect(await resolveBoardPath(store, 'demo')).toBe('projects/demo/board.md')
    expect(await resolveBoardPath(store, 'projects/demo/board.md')).toBe('projects/demo/board.md')
    expect(await resolveBoardPath(store, 'nope')).toBeNull()
  })
})

describe('findCardByQuery', () => {
  it('matches ^id, exact text, unique substring; rejects ambiguity', () => {
    const board = parseBoard(BOARD)
    expect(findCardByQuery(board, '^aa11bb')).toMatchObject({ ref: { column: 'Backlog', index: 1 } })
    expect(findCardByQuery(board, 'Going')).toMatchObject({ ref: { column: 'In Progress', index: 0 } })
    expect(findCardByQuery(board, 'idea')).toMatchObject({ error: expect.stringContaining('ambiguous') })
    expect(findCardByQuery(board, 'zzz')).toMatchObject({ error: expect.stringContaining('no card') })
  })
})

describe('BoardOps mutations', () => {
  it('show returns columns and cards', async () => {
    const r = await ops.show('demo')
    expect(r.path).toBe('projects/demo/board.md')
    expect(r.columns.map((c) => c.title)).toEqual(['Backlog', 'In Progress', 'Done'])
    expect(r.columns[0]!.cards[1]!.detail).toEqual(['- existing note'])
  })

  it('add prepends by default with assignee + detail', async () => {
    await ops.add('demo', 'New card', { column: 'Backlog', agentKey: 'al', detail: ['a', 'b'] })
    const disk = onDisk()
    expect(disk).toContain('- [ ] New card @al')
    expect(disk.indexOf('New card')).toBeLessThan(disk.indexOf('First idea'))
    expect(disk).toContain('  a')
  })

  it('move relocates by ^id and ticks in Done', async () => {
    await ops.move('demo', '^cc22dd', 'done')
    expect(onDisk()).toContain('- [x] Going @eng ^cc22dd')
    expect(parseBoard(onDisk()).columns[1]!.cards).toHaveLength(0)
  })

  it('assign, block-with-note, unblock, note, edit, remove', async () => {
    await ops.assign('demo', '^aa11bb', 'other-agent')
    expect(onDisk()).toContain('Second idea @other-agent ^aa11bb')

    await ops.setBlocked('demo', '^aa11bb', true, 'waiting on API keys')
    expect(onDisk()).toContain('Second idea #blocked @other-agent ^aa11bb')
    expect(onDisk()).toContain('  waiting on API keys')

    await ops.setBlocked('demo', '^aa11bb', false)
    expect(onDisk()).not.toContain('#blocked')

    await ops.note('demo', 'First idea', 'a thought')
    expect(onDisk()).toContain('  a thought')

    await ops.edit('demo', '^aa11bb', { text: 'Second idea, sharper' })
    expect(onDisk()).toContain('Second idea, sharper @other-agent ^aa11bb')

    const r = await ops.remove('demo', 'First idea')
    expect(r.removed).toBe('First idea')
    expect(onDisk()).not.toContain('First idea')
  })

  it('serializes concurrent mutations — no lost updates', async () => {
    // Fire 10 adds without awaiting; all must land.
    await Promise.all(Array.from({ length: 10 }, (_, i) => ops.add('demo', `Card ${i}`, { column: 'Backlog' })))
    const board = parseBoard(onDisk())
    const texts = board.columns[0]!.cards.map((c) => c.text)
    for (let i = 0; i < 10; i++) expect(texts).toContain(`Card ${i}`)
  })

  it('a failed mutation does not wedge the lock', async () => {
    await expect(ops.move('demo', '^nope99', 'Done')).rejects.toThrow(/no card/)
    await ops.add('demo', 'After failure', {})
    expect(onDisk()).toContain('After failure')
  })
})

describe('default owner', () => {
  it('setDefaultOwner writes/clears frontmatter and show() reflects it', async () => {
    expect((await ops.show('demo')).defaultOwner).toBeNull()
    expect(await ops.setDefaultOwner('demo', 'demo-general')).toMatchObject({ defaultOwner: 'demo-general' })
    expect(onDisk()).toMatch(/^---\nkanban-plugin: board\ndefault_owner: demo-general\n---\n/)
    expect((await ops.show('demo')).defaultOwner).toBe('demo-general')
    expect(await ops.setDefaultOwner('demo', null)).toMatchObject({ defaultOwner: null })
    expect(onDisk()).toBe(BOARD)
  })
})

describe('actor ledger', () => {
  it('records the acting agent per card and prunes', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'boardops-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'demo', 'board.md'),
      '---\nkanban-plugin: board\n---\n\n## In Progress\n\n- [ ] Work @eng ^ab12cd\n\n## Under Review\n')
    const actorFile = join(dir, 'actors.json')
    const ops = new BoardOps(new NoteStore(dir), actorFile)
    try {
      await ops.move('demo', '^ab12cd', 'Under Review', 'eng')
      expect(existsSync(actorFile)).toBe(true)
      const ledger = JSON.parse(readFileSync(actorFile, 'utf-8'))
      const rec = ledger['projects/demo/board.md#ab12cd']
      expect(rec.actor).toBe('eng')
      expect(typeof rec.ts).toBe('number')
      // No actor header → no record change.
      await ops.note('demo', '^ab12cd', 'anonymous note')
      const after = JSON.parse(readFileSync(actorFile, 'utf-8'))
      expect(after['projects/demo/board.md#ab12cd'].actor).toBe('eng')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
