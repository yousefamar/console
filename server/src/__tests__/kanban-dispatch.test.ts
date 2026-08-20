import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { parseBoard } from '../kanban/board.js'
import { findDispatchable, inFlightCards, mintBlockId, buildBoardEnvelope } from '../kanban/dispatch.js'
import { BoardWatcher, projectForBoardPath, type BoardDispatch, type BoardTransition } from '../kanban/watcher.js'
import { NoteStore } from '../notes.js'

const BOARD = (inProgress: string) => `---
kanban-plugin: board
---

## Backlog

- [ ] Unassigned idea
- [ ] Planned for eng @eng

## In Progress
${inProgress}

## Blocked


## Done

- [x] Old thing
`

describe('findDispatchable', () => {
  it('dispatches only assigned+unstamped cards in dispatch columns', () => {
    const board = parseBoard(BOARD('\n- [ ] Do the thing @eng\n- [ ] Already going @eng ^aa11bb\n- [ ] No assignee\n'))
    const d = findDispatchable(board)
    expect(d).toHaveLength(1)
    expect(d[0]!.card.text).toBe('Do the thing')
    expect(d[0]!.card.agentKey).toBe('eng')
  })
})

describe('inFlightCards', () => {
  it('reports every stamped card with done/blocked flags', () => {
    const board = parseBoard(`---
kanban-plugin: board
---

## In Progress

- [ ] Going @eng ^id1

## Blocked

- [ ] Stuck @eng ^id2

## Done

- [x] Finished @eng ^id3
`)
    const flights = inFlightCards(board)
    expect(flights.map((f) => [f.blockId, f.done, f.blocked])).toEqual([
      ['id1', false, false],
      ['id2', false, true],
      ['id3', true, false],
    ])
  })
})

describe('mintBlockId', () => {
  it('is 6 chars lowercase alphanumeric', () => {
    expect(mintBlockId()).toMatch(/^[a-z0-9]{6}$/)
  })
})

describe('buildBoardEnvelope', () => {
  it('names the board, card, and reporting contract', () => {
    const env = buildBoardEnvelope({
      boardAbsPath: '/vault/projects/astera/board.md',
      card: { text: 'Fix the parser', blockId: 'abc123', lines: ['- [ ] Fix the parser @eng ^abc123', '  see notes/x.md'] },
      column: 'In Progress',
      project: 'astera',
    })
    expect(env).toContain('[BOARD TASK')
    expect(env).toContain('/vault/projects/astera/board.md')
    expect(env).toContain('Fix the parser')
    expect(env).toContain('see notes/x.md')
    expect(env).toContain('^abc123')
    expect(env).toContain('## Under Review')
    expect(env).toContain('#blocked')
    expect(env).toContain('NEVER move your')
  })
})

describe('projectForBoardPath', () => {
  it('extracts the project slug', () => {
    expect(projectForBoardPath('projects/astera/board.md')).toBe('astera')
    expect(projectForBoardPath('al/boards/infrastructure.md')).toBeNull()
  })
})

describe('BoardWatcher', () => {
  async function setup(initial: string) {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, initial)
    const store = new NoteStore(dir)
    const dispatches: BoardDispatch[] = []
    const transitions: BoardTransition[] = []
    let clock = 1_000_000
    const watcher = new BoardWatcher(store, {
      log: () => {},
      onDispatch: (d) => { dispatches.push(d); return true },
      onTransition: (t) => transitions.push(t),
      pollMs: 999_999, // manual polls only
      now: () => clock,
    })
    return { dir, boardAbs, store, watcher, dispatches, transitions, tick: (ms: number) => { clock += ms } }
  }

  it('boot: stamps + dispatches an assigned card, and the stamp is durable', async () => {
    const { dir, boardAbs, watcher, dispatches } = await setup(BOARD('\n- [ ] Ship it @eng\n'))
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]!.card.agentKey).toBe('eng')
      expect(dispatches[0]!.project).toBe('demo')
      const onDisk = readFileSync(boardAbs, 'utf-8')
      expect(onDisk).toMatch(/- \[ \] Ship it @eng \^[a-z0-9]{6}/)
      // A restart must NOT re-dispatch (the stamp marks it).
      const { watcher: w2, dispatches: d2 } = { ...(await setup('')), dispatches: [] as BoardDispatch[] }
      void w2
      const store2 = new NoteStore(dir)
      const watcher2 = new BoardWatcher(store2, { log: () => {}, onDispatch: (d) => { d2.push(d); return true }, pollMs: 999_999 })
      await watcher2.start()
      expect(d2).toHaveLength(0)
      watcher2.stop()
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('onDispatch returning a string reassigns the card to the fork key on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, BOARD('\n- [ ] Ship it @eng\n'))
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {},
      onDispatch: () => 'eng-abc123-fork', // ticket-fork owns the card now
      pollMs: 999_999,
    })
    try {
      await watcher.start()
      const onDisk = readFileSync(boardAbs, 'utf-8')
      expect(onDisk).toMatch(/- \[ \] Ship it @eng-abc123-fork \^[a-z0-9]{6}/)
      expect(onDisk).not.toMatch(/@eng \^/)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('poll: detects a card assigned after boot, then its transition to Done', async () => {
    const { dir, boardAbs, watcher, dispatches, transitions, tick } = await setup(BOARD('\n'))
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(0)
      // Assign a card (as a human/agent edit would).
      tick(5_000)
      writeFileSync(boardAbs, BOARD('\n- [ ] New work @eng\n'))
      await watcher.poll()
      expect(dispatches).toHaveLength(1)
      const id = dispatches[0]!.card.blockId!
      // Agent completes: move the line to Done.
      tick(5_000)
      const done = readFileSync(boardAbs, 'utf-8')
        .replace(`- [ ] New work @eng ^${id}\n`, '')
        .replace('## Done\n', `## Done\n\n- [x] New work @eng ^${id}`)
      writeFileSync(boardAbs, done)
      await watcher.poll()
      expect(transitions).toHaveLength(1)
      expect(transitions[0]!.blockId).toBe(id)
      expect(transitions[0]!.done).toBe(true)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not treat a non-board md file as a board', async () => {
    const { dir, watcher } = await setup(BOARD('\n'))
    try {
      writeFileSync(join(dir, 'projects', 'demo', 'notes.md'), '# Just notes\n- [ ] a checklist @eng\n')
      await watcher.start()
      expect(watcher.boardPaths()).toEqual(['projects/demo/board.md'])
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('boardDeployGate + envelope', () => {
  it('detects deploy_gate: review in frontmatter, absent otherwise', async () => {
    const { boardDeployGate } = await import('../kanban/board.js')
    expect(boardDeployGate('---\nkanban-plugin: board\ndeploy_gate: review\n---\n## A\n')).toBe('review')
    expect(boardDeployGate('---\nkanban-plugin: board\n---\n## A\n')).toBeNull()
    expect(boardDeployGate('---\nkanban-plugin: board\ndeploy_gate: nonsense\n---\n')).toBeNull()
  })

  it('gated envelope forbids merge + demands branch/preview; ungated keeps fold-into-main', () => {
    const base = {
      boardAbsPath: '/v/projects/astera/board.md',
      card: { text: 'Ship it', blockId: 'ab12cd', lines: ['- [ ] Ship it @eng ^ab12cd'] },
      column: 'In Progress',
      project: 'astera',
    }
    const gated = buildBoardEnvelope({ ...base, deployGate: 'review' })
    expect(gated).toContain('do NOT merge to main')
    expect(gated).toContain('preview')
    expect(gated).not.toContain('fold the work back')
    const ungated = buildBoardEnvelope({ ...base, deployGate: null })
    expect(ungated).toContain('fold the work back')
    expect(ungated).not.toContain('do NOT merge to main')
  })
})
