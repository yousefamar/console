import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSpaces } from '../spaces.js'
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

  it('zero for boardless projects and areas', async () => {
    const store = vault()
    mkdirSync(join(dir!, 'projects/plain'), { recursive: true })
    writeFileSync(join(dir!, 'projects/plain/index.md'), '# Plain\n')
    const spaces = await listSpaces(store)
    const plain = spaces.find((s) => s.slug === 'plain')!
    expect(plain.reviewCount).toBe(0)
    expect(plain.reviewAgentKeys).toEqual([])
  })
})
