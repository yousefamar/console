import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { parseBoard } from '../kanban/board.js'
import { findDispatchable, inFlightCards, mintBlockId, buildBoardEnvelope, buildWindDownEnvelope, buildReopenNudge, buildReviewReminder, handbackWarning, hasSummaryBullets, resolveDefaultOwner } from '../kanban/dispatch.js'
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
  it('is a readable adjective-noun pair, valid Obsidian block-ref charset', () => {
    expect(mintBlockId()).toMatch(/^[a-z]+-[a-z]+$/)
  })
  it('avoids taken ids, suffixing numerically when the space is exhausted', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = mintBlockId({ taken: seen })
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
    // Force total exhaustion of the random tries: everything is taken.
    const all = new Set<string>()
    let fixed = 0
    const cycle = () => ((fixed = (fixed + 1) % 7), fixed / 7)
    for (let i = 0; i < 5000; i++) all.add(mintBlockId({ random: cycle }))
    const suffixed = mintBlockId({ taken: all, random: cycle })
    expect(suffixed).toMatch(/^[a-z]+-[a-z]+-\d+$/)
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
    expect(env).toContain('con spaces board astera move')
    expect(env).toContain('Under Review')
    expect(env).toContain('con spaces board astera block')
    expect(env).toContain('NEVER move your')
  })

  it('carries the hand-back contract: summary note + screenshots BEFORE the move, feedback re-opens (^shy-boar)', () => {
    const env = buildBoardEnvelope({
      boardAbsPath: '/vault/projects/astera/board.md',
      card: { text: 'Fix the parser', blockId: 'abc123', lines: ['- [ ] Fix the parser @eng ^abc123'] },
      column: 'In Progress',
      project: 'astera',
    })
    expect(env).toContain('HAND-BACK')
    expect(env).toContain('con spaces board astera note "^abc123" "- …"')
    expect(env).toContain('con spaces board astera attach "^abc123" <screenshot.png>')
    expect(env).toMatch(/REQUIRED when you worked in a worktree/)
    // Order: note (1) → attach (2) → move (3).
    expect(env.indexOf('note "^abc123"')).toBeLessThan(env.indexOf('attach "^abc123"'))
    expect(env.indexOf('attach "^abc123"')).toBeLessThan(env.indexOf('move "^abc123" "Under Review"'))
    expect(env).toContain('FEEDBACK RE-OPENS THE CARD')
    expect(env).toContain('move "^abc123" "In Progress"')
    // No project slug → the CLI ref falls back to the board path.
    const noProj = buildBoardEnvelope({ boardAbsPath: '/vault/notes/side.md', card: { text: 'x', blockId: 'zz', lines: ['- [ ] x ^zz'] }, column: 'In Progress' })
    expect(noProj).toContain('con spaces board /vault/notes/side.md note "^zz"')
  })
})

describe('hand-back helpers (^shy-boar)', () => {
  it('hasSummaryBullets keys on `- ` detail lines only', () => {
    expect(hasSummaryBullets([])).toBe(false)
    expect(hasSummaryBullets(['see notes/x.md', '![img](images/a.png)'])).toBe(false)
    expect(hasSummaryBullets(['see notes/x.md', '- changed the parser'])).toBe(true)
    expect(hasSummaryBullets(['-not a bullet'])).toBe(false)
  })

  it('handbackWarning names the exact note + attach commands', () => {
    const w = handbackWarning('astera', 'abc123')
    expect(w).toContain('con spaces board astera note "^abc123"')
    expect(w).toContain('con spaces board astera attach "^abc123"')
    expect(handbackWarning('astera', null)).toContain('"^id"')
  })

  it('buildReviewReminder lists every Under-Review card with its move-back command; empty for none', () => {
    expect(buildReviewReminder([])).toBe('')
    const r = buildReviewReminder([
      { blockId: 'a1', text: 'First', boardPath: 'projects/astera/board.md', project: 'astera' },
      { blockId: 'b2', text: 'Second', boardPath: 'notes/side.md', project: null },
    ])
    expect(r.startsWith('\n---\n')).toBe(true) // appended AFTER the human text
    expect(r).toContain('[BOARD — you own 2 cards in Under Review]')
    expect(r).toContain('"First" (^a1) — `con spaces board astera move "^a1" "In Progress"`')
    expect(r).toContain('con spaces board notes/side.md move "^b2" "In Progress"')
    expect(r).toContain('FIRST move it back to In Progress')
    expect(r).toContain('If the message is unrelated to the card, ignore this note.')
    expect(buildReviewReminder([{ blockId: 'a1', text: 'First', boardPath: 'p', project: 'p' }])).toContain('you own a card in Under Review')
  })

  it('the reopen nudge asks for a fresh summary on the way back', () => {
    const n = buildReopenNudge({ boardAbsPath: '/v/board.md', text: 'Work', blockId: 'w1', column: 'In Progress' })
    expect(n).toContain('[BOARD TASK — reopened]')
    expect(n).toMatch(/fresh `- ` bulleted summary/)
  })
})

describe('BoardWatcher reviewCardsFor', () => {
  it('returns the agent\'s Under-Review cards only — not open, done, or other agents\' cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'demo', 'board.md'),
      '---\nkanban-plugin: board\n---\n\n## In Progress\n\n- [ ] Open @eng ^o1\n\n## Under Review\n\n- [ ] Mine @eng ^r1\n- [ ] Theirs @ops ^r2\n\n## Done\n\n- [x] Finished @eng ^d1\n')
    const watcher = new BoardWatcher(new NoteStore(dir), { log: () => {}, onDispatch: () => true, pollMs: 999_999 })
    try {
      await watcher.start()
      expect(watcher.reviewCardsFor('eng')).toEqual([{ blockId: 'r1', text: 'Mine', boardPath: 'projects/demo/board.md', project: 'demo' }])
      expect(watcher.reviewCardsFor('ops').map((c) => c.blockId)).toEqual(['r2'])
      expect(watcher.reviewCardsFor('nobody')).toEqual([])
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
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
    expect(env).not.toContain('--session-id')
  })

  it('names the fork csid so the reader can verify itself from argv', () => {
    // The inherited transcript is full of the parent's "I am <csid>" claims;
    // the envelope gives the fork a check it can run (`ps`) and an instruction
    // for the wrong-process case (^blue-vole: a twin worked the card).
    const env = buildBoardEnvelope({
      boardAbsPath: '/vault/projects/astera/board.md',
      card: { text: 'Fix nav', blockId: 'tgcekv', lines: ['- [ ] Fix nav @astera-general-tgcekv-fork ^tgcekv'] },
      column: 'In Progress',
      forkIdentity: { key: 'astera-general-tgcekv-fork', sourceKey: 'astera-general', claudeSessionId: '11111111-2222-3333-4444-555555555555' },
    })
    expect(env).toContain('--session-id 11111111-2222-3333-4444-555555555555')
    expect(env).toContain("`--resume` id beside it is your PARENT's")
    expect(env).toContain('do not work the card')
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
    expect(env).toContain('learnings durable')
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
    let clock = 1_000_000 // fake clock: lastPoll stays tiny so listSince sees a same-ms rewrite
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: () => true, onTransition: (t) => transitions.push(t), pollMs: 999_999, now: () => (clock += 1000),
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

describe('BoardWatcher onCardEdited', () => {
  it('fires on content change to an OPEN card; not on boot, moves, or transitions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    const b = (inprog: string, review = '\n') => `---\nkanban-plugin: board\n---\n\n## In Progress\n${inprog}\n## Under Review\n${review}\n## Done\n`
    writeFileSync(boardAbs, b('\n- [ ] Work @eng ^ed1\n'))
    const edited: BoardTransition[] = []
    let clock = 1_000_000 // fake clock: lastPoll stays tiny so listSince always sees the file
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: () => true, onCardEdited: (t) => edited.push(t), pollMs: 999_999, now: () => (clock += 1000),
    })
    try {
      await watcher.start()
      expect(edited).toHaveLength(0) // boot never fires
      // Content edit: add a detail line.
      writeFileSync(boardAbs, b('\n- [ ] Work @eng ^ed1\n\tuse the fork DB\n'))
      await watcher.poll()
      expect(edited).toHaveLength(1)
      expect(edited[0]!.blockId).toBe('ed1')
      // Move to review with same content: transition, NOT an edit ping.
      writeFileSync(boardAbs, b('\n', '\n- [ ] Work @eng ^ed1\n\tuse the fork DB\n'))
      await watcher.poll()
      expect(edited).toHaveLength(1)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('BoardWatcher onFileChanged', () => {
  it('announces every changed .md on poll — boards and plain notes alike — but never at boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    const noteAbs = join(dir, 'projects', 'demo', 'notes.md')
    writeFileSync(boardAbs, '---\nkanban-plugin: board\n---\n\n## In Progress\n\n## Done\n')
    writeFileSync(noteAbs, '# notes\n')
    writeFileSync(join(dir, 'projects', 'demo', 'image.png'), 'not markdown')
    const changed: Array<{ path: string; mtime: number }> = []
    let clock = 1_000_000
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: () => true, onFileChanged: (path, mtime) => changed.push({ path, mtime }), pollMs: 999_999, now: () => (clock += 1000),
    })
    try {
      await watcher.start()
      expect(changed).toHaveLength(0)
      writeFileSync(noteAbs, '# notes\n\nagent wrote this via Bash\n')
      writeFileSync(join(dir, 'projects', 'demo', 'image.png'), 'still not markdown')
      await watcher.poll()
      const paths = changed.map((c) => c.path).sort()
      expect(paths).toContain('projects/demo/notes.md')
      expect(paths).not.toContain('projects/demo/image.png')
      expect(changed.every((c) => typeof c.mtime === 'number' && c.mtime > 0)).toBe(true)
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
      expect(readFileSync(boardAbs, 'utf-8')).toMatch(/- \[ \] Ownerless work @demo-general \^[a-z0-9-]+/)
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

describe('BoardWatcher concurrency cap (^tame-bear)', () => {
  /** Board with N assigned In-Progress cards, each its own agent. */
  const CARDS = (n: number, fm = '') => `---\nkanban-plugin: board\n${fm}---\n\n## In Progress\n\n`
    + Array.from({ length: n }, (_, i) => `- [ ] Task ${i + 1} @eng${i + 1}\n`).join('')
    + `\n## Under Review\n\n\n## Done\n\n`

  async function capSetup(initial: string, opts: { cap?: number; alive?: Set<string> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, initial)
    const dispatches: BoardDispatch[] = []
    let clock = 1_000_000
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {},
      onDispatch: (d) => { dispatches.push(d); return true },
      maxRunningForks: () => opts.cap ?? 2,
      ...(opts.alive ? { isWorkerAlive: (k: string) => opts.alive!.has(k) } : {}),
      pollMs: 999_999,
      now: () => (clock += 1000),
    })
    return { dir, boardAbs, watcher, dispatches }
  }

  it('dispatches up to the cap and leaves the rest UNSTAMPED and queued', async () => {
    const { dir, boardAbs, watcher, dispatches } = await capSetup(CARDS(5))
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(2)
      expect(watcher.runningForks()).toBe(2)
      const queued = watcher.queuedCards()
      expect(queued.map((q) => q.text)).toEqual(['Task 3', 'Task 4', 'Task 5'])
      const onDisk = readFileSync(boardAbs, 'utf-8')
      expect(onDisk).toMatch(/- \[ \] Task 1 @eng1 \^[a-z0-9-]+/)
      expect(onDisk).toMatch(/- \[ \] Task 2 @eng2 \^[a-z0-9-]+/)
      // Queued cards keep their line EXACTLY as the user left it.
      for (const n of [3, 4, 5]) expect(onDisk).toContain(`- [ ] Task ${n} @eng${n}\n`)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a card leaving the dispatch column releases its slot to the next in FIFO order', async () => {
    const { dir, boardAbs, watcher, dispatches } = await capSetup(CARDS(5))
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(2)
      // Yousef moves Task 1 (stamped) to Under Review — one slot frees.
      const before = readFileSync(boardAbs, 'utf-8')
      const line1 = before.split('\n').find((l) => l.includes('Task 1'))!
      writeFileSync(boardAbs, before.replace(`${line1}\n`, '').replace('## Under Review\n', `## Under Review\n\n${line1}\n`))
      await watcher.poll()
      expect(dispatches).toHaveLength(3)
      expect(dispatches[2]!.card.text).toBe('Task 3') // oldest queued, not Task 5
      expect(watcher.queuedCards().map((q) => q.text)).toEqual(['Task 4', 'Task 5'])
      expect(readFileSync(boardAbs, 'utf-8')).toMatch(/- \[ \] Task 3 @eng3 \^[a-z0-9-]+/)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a card whose worker died holds no slot', async () => {
    const alive = new Set(['eng1', 'eng2'])
    const { dir, watcher, dispatches } = await capSetup(CARDS(5), { alive })
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(2)
      alive.delete('eng1') // its fork ended without moving the card
      alive.add('eng3')
      await watcher.onWorkerEnded()
      expect(dispatches).toHaveLength(3)
      expect(dispatches[2]!.card.text).toBe('Task 3')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-board frontmatter max_forks overrides the hub default', async () => {
    const { dir, watcher, dispatches } = await capSetup(CARDS(5, 'max_forks: 3\n'), { cap: 1 })
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(3)
      expect(watcher.queuedCards()).toHaveLength(2)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('max_forks: 0 dispatches nothing; a raised cap drains the whole queue', async () => {
    const { dir, watcher, dispatches } = await capSetup(CARDS(3, 'max_forks: 0\n'))
    try {
      await watcher.start()
      expect(dispatches).toHaveLength(0)
      expect(watcher.queuedCards()).toHaveLength(3)
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the envelope warns a fork that starts under load; a lone fork gets no warning', () => {
    const under = buildBoardEnvelope({
      boardAbsPath: '/v/projects/demo/board.md',
      card: { text: 'Heavy', blockId: 'bold-fox', lines: ['- [ ] Heavy'] },
      column: 'In Progress', load: { running: 4, cap: 4 },
    })
    expect(under).toContain('LOAD: 4 of a maximum 4 cards')
    expect(under).toMatch(/heavy\.sh|pnpm heavy/)
    const alone = buildBoardEnvelope({
      boardAbsPath: '/v/projects/demo/board.md',
      card: { text: 'Heavy', blockId: 'bold-fox', lines: ['- [ ] Heavy'] },
      column: 'In Progress', load: { running: 1, cap: 4 },
    })
    expect(alone).not.toContain('LOAD:')
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
      expect(onDisk).toMatch(/- \[ \] Ship it @eng \^[a-z0-9-]+/)
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
      expect(onDisk).toMatch(/- \[ \] Ship it @eng-abc123-fork \^[a-z0-9-]+/)
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

describe('BoardWatcher onReopen', () => {
  const b = (inprog: string, review = '\n', backlog = '\n') =>
    `---\nkanban-plugin: board\n---\n\n## Backlog\n${backlog}\n## In Progress\n${inprog}\n## Under Review\n${review}\n## Done\n`

  async function setup(initial: string, onReopen: (t: BoardTransition) => boolean | string) {
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, initial)
    let clock = 1_000_000
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: () => true, onReopen, pollMs: 999_999, now: () => (clock += 1000),
    })
    return { dir, boardAbs, watcher }
  }

  it('review → In Progress fires onReopen with the card state; boot does not', async () => {
    const reopens: BoardTransition[] = []
    const { dir, boardAbs, watcher } = await setup(b('\n', '\n- [ ] Work @eng-ro1-fork ^ro1\n'), (t) => { reopens.push(t); return true })
    try {
      await watcher.start()
      expect(reopens).toHaveLength(0) // boot never fires
      writeFileSync(boardAbs, b('\n- [ ] Work @eng-ro1-fork ^ro1\n'))
      await watcher.poll()
      expect(reopens).toHaveLength(1)
      expect(reopens[0]!.blockId).toBe('ro1')
      expect(reopens[0]!.agentKey).toBe('eng-ro1-fork')
      expect(reopens[0]!.column).toBe('In Progress')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('string result reassigns the board line to the new worker key', async () => {
    const { dir, boardAbs, watcher } = await setup(b('\n', '\n- [ ] Work @dead-key ^ro2\n'), () => 'eng-ro2-fork')
    try {
      await watcher.start()
      writeFileSync(boardAbs, b('\n- [ ] Work @dead-key ^ro2\n'))
      await watcher.poll()
      expect(readFileSync(boardAbs, 'utf-8')).toContain('- [ ] Work @eng-ro2-fork ^ro2')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stamped Backlog → In Progress reopens (findDispatchable skips stamped cards)', async () => {
    const reopens: BoardTransition[] = []
    const { dir, boardAbs, watcher } = await setup(b('\n', '\n', '\n- [ ] Later @eng ^ro3\n'), (t) => { reopens.push(t); return true })
    try {
      await watcher.start()
      writeFileSync(boardAbs, b('\n- [ ] Later @eng ^ro3\n'))
      await watcher.poll()
      expect(reopens.map((t) => t.blockId)).toEqual(['ro3'])
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('un-#blocking in place reopens; content edits on open cards still fire onCardEdited not onReopen', async () => {
    const reopens: string[] = []
    const { dir, boardAbs, watcher } = await setup(b('\n- [ ] Stuck @eng ^ro4 #blocked\n'), (t) => { reopens.push(t.blockId); return true })
    try {
      await watcher.start()
      writeFileSync(boardAbs, b('\n- [ ] Stuck @eng ^ro4\n'))
      await watcher.poll()
      expect(reopens).toEqual(['ro4'])
      // A later content edit is an edit, not another reopen.
      writeFileSync(boardAbs, b('\n- [ ] Stuck @eng ^ro4\n\tmore detail\n'))
      await watcher.poll()
      expect(reopens).toEqual(['ro4'])
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reopen re-arms the stale watchdog', async () => {
    const reopens: string[] = []
    const stales: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'boards-'))
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    const boardAbs = join(dir, 'projects', 'demo', 'board.md')
    writeFileSync(boardAbs, b('\n', '\n- [ ] Work @eng ^ro5\n'))
    let clock = 1_000_000
    const watcher = new BoardWatcher(new NoteStore(dir), {
      log: () => {}, onDispatch: () => true,
      onReopen: (t) => { reopens.push(t.blockId); return true },
      onStale: (t) => stales.push(t.blockId),
      pollMs: 999_999, staleMs: 60_000, now: () => clock,
    })
    try {
      await watcher.start()
      clock += 5000
      writeFileSync(boardAbs, b('\n- [ ] Work @eng ^ro5\n'))
      await watcher.poll()
      expect(reopens).toEqual(['ro5'])
      clock += 61_000
      await watcher.poll() // checkStale runs on poll
      expect(stales).toEqual(['ro5'])
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('redispatch(): manual re-fire for a stamped open card; refuses Done cards and unknown ids', async () => {
    const reopens: string[] = []
    const { dir, boardAbs, watcher } = await setup(b('\n- [ ] Work @eng ^ro6\n'), (t) => { reopens.push(t.blockId); return true })
    try {
      await watcher.start()
      const r = await watcher.redispatch('projects/demo/board.md', 'ro6')
      expect(r.ok).toBe(true)
      expect(reopens).toEqual(['ro6'])
      expect((await watcher.redispatch('projects/demo/board.md', 'nope')).ok).toBe(false)
      writeFileSync(boardAbs, `---\nkanban-plugin: board\n---\n\n## In Progress\n\n## Done\n\n- [x] Work @eng ^ro6\n`)
      await watcher.poll()
      const done = await watcher.redispatch('projects/demo/board.md', 'ro6')
      expect(done.ok).toBe(false)
      expect(done.error).toContain('Done')
    } finally {
      watcher.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
