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
