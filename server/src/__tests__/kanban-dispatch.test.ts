import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { parseBoard } from '../kanban/board.js'
import { findDispatchable, inFlightCards, mintBlockId, buildBoardEnvelope, buildWindDownEnvelope, resolveDefaultOwner } from '../kanban/dispatch.js'
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
  it('includes unstamped cards in dispatch columns — assigned AND unassigned', () => {
    const board = parseBoard(BOARD('\n- [ ] Do the thing @eng\n- [ ] Already going @eng ^aa11bb\n- [ ] No assignee\n'))
    const d = findDispatchable(board)
    expect(d.map((x) => [x.card.text, x.card.agentKey])).toEqual([
      ['Do the thing', 'eng'],
      ['No assignee', null], // resolved to the default owner by the watcher
    ])
  })
})

describe('resolveDefaultOwner', () => {
  const role = (key: string, title = key, extra: { fork?: boolean; folder?: boolean } = {}) => ({ key, title, ...extra })
  it('single role wins', () => {
    expect(resolveDefaultOwner([role('feeds-tab')])).toBe('feeds-tab')
  })
  it('"general" suffix wins among several', () => {
    expect(resolveDefaultOwner([role('astera-kitchen'), role('astera-general', 'Astera general'), role('astera-planning')])).toBe('astera-general')
  })
  it('falls back to first by key order', () => {
    expect(resolveDefaultOwner([role('zeta'), role('alpha')])).toBe('alpha')
  })
  it('ignores forks and folders; empty → null', () => {
    expect(resolveDefaultOwner([role('x-general-fork', 'X general (fork)', { fork: true }), role('grp', 'grp', { folder: true })])).toBeNull()
    expect(resolveDefaultOwner([])).toBeNull()
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

describe('buildBoardEnvelope fork identity', () => {
  it('names the fork key and warns against standing down', () => {
    const env = buildBoardEnvelope({
      boardAbsPath: '/vault/projects/astera/board.md',
      card: { text: 'Fix nav', blockId: 'tgcekv', lines: ['- [ ] Fix nav @astera-general-tgcekv-fork ^tgcekv'] },
      column: 'In Progress',
      forkIdentity: { key: 'astera-general-tgcekv-fork', sourceKey: 'astera-general' },
    })
    expect(env).toContain('YOU are the dedicated fork')
    expect(env).toContain('`astera-general-tgcekv-fork`')
    expect(env).toContain('no longer `astera-general`')
    expect(env).toContain('you ARE it')
  })

  it('omits the identity block for non-fork dispatch', () => {
    const env = buildBoardEnvelope({
      boardAbsPath: '/v/b.md',
      card: { text: 'x', blockId: 'aa', lines: ['- [ ] x @eng ^aa'] },
      column: 'In Progress',
    })
    expect(env).not.toContain('IDENTITY')
  })
})

describe('buildWindDownEnvelope', () => {
  it('gated: approval is the merge/deploy signal', () => {
    const env = buildWindDownEnvelope({ boardAbsPath: '/v/b.md', text: 'Fix nav', blockId: 'aa', deployGate: 'review' })
    expect(env).toContain('[CARD APPROVED — wind down]')
    expect(env).toContain('Merge your branch into main (this deploys)')
    expect(env).toContain('autowt cleanup')
    expect(env).toContain('hub automatically merges your summary')
  })
  it('ungated: verify folded + clean up', () => {
    const env = buildWindDownEnvelope({ boardAbsPath: '/v/b.md', text: 'x', blockId: 'aa', deployGate: null })
    expect(env).toContain('folded into the project')
    expect(env).not.toContain('this deploys')
  })
})

describe('transition deployGate threading', () => {
  it('BoardTransition carries the board gate', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    const gated = (inprog: string, done: string) => `---\nkanban-plugin: board\ndeploy_gate: review\n---\n\n## In Progress\n${inprog}\n## Done\n${done}`
    writeFileSync(boardAbs, gated('\n- [ ] Work @eng ^gg11\n', '\n'))
    const transitions: BoardTransition[] = []
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: () => true, onTransition: (t) => transitions.push(t), pollMs: 999_999,
    })
    try {
      await watcher.start()
      void readFileSync
      writeFileSync(boardAbs, gated('\n', '\n- [x] Work @eng ^gg11\n'))
      await watcher.poll()
      expect(transitions).toHaveLength(1)
      expect(transitions[0]!.done).toBe(true)
      expect(transitions[0]!.deployGate).toBe('review')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('BoardWatcher default owner', () => {
  it('auto-assigns an unassigned In Progress card via resolveOwner and stamps it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, BOARD('\n- [ ] Ownerless work\n'))
    const dispatches: BoardDispatch[] = []
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {},
      onDispatch: (d) => { dispatches.push(d); return true },
      resolveOwner: (project) => (project === 'demo' ? 'demo-general' : null),
      pollMs: 999_999,
    })
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]!.card.agentKey).toBe('demo-general')
      expect(readFileSync(boardAbs, 'utf-8')).toMatch(/- \[ \] Ownerless work @demo-general \^[a-z0-9]{6}/)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('frontmatter default_owner beats the resolver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, `---\nkanban-plugin: board\ndefault_owner: demo-special\n---\n\n## In Progress\n\n- [ ] Ownerless work\n`)
    const dispatches: BoardDispatch[] = []
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {},
      onDispatch: (d) => { dispatches.push(d); return true },
      resolveOwner: () => 'demo-general',
      pollMs: 999_999,
    })
    try {
      await watcher.start()
      expect(dispatches[0]!.card.agentKey).toBe('demo-special')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no owner resolvable → card left unstamped and undispatched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, BOARD('\n- [ ] Ownerless work\n'))
    const dispatches: BoardDispatch[] = []
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: (d) => { dispatches.push(d); return true }, pollMs: 999_999,
    })
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(0)
      expect(readFileSync(boardAbs, 'utf-8')).toContain('- [ ] Ownerless work\n')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('a stale write wiping a fresh stamp re-stamps WITHOUT re-dispatching (duplicate-fork guard)', async () => {
    const { dir, boardAbs, watcher, dispatches, tick } = await setup(BOARD('\n'))
    try {
      await watcher.start()
      // Assign → first dispatch stamps ^id (+ fork key via string return in prod).
      tick(5_000)
      writeFileSync(boardAbs, BOARD('\n- [ ] Big feature @eng\n'))
      await watcher.poll()
      expect(dispatches).toHaveLength(1)
      const id = dispatches[0]!.card.blockId!
      // A client holding a PRE-stamp copy saves the whole file — the stamp
      // vanishes (exactly what the SPA did between two rapid drags).
      tick(5_000)
      writeFileSync(boardAbs, BOARD('\n- [ ] Big feature @eng\n'))
      await watcher.poll()
      // No second dispatch; the original id is restored on disk.
      expect(dispatches).toHaveLength(1)
      expect(readFileSync(boardAbs, 'utf-8')).toContain(`^${id}`)
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
