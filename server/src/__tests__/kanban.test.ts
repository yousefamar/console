import { describe, it, expect } from 'vitest'
import {
  isKanbanBoard, parseCardTokens, parseBoard, serializeBoard,
  findCardByBlockId, getCard, moveCard, addCard, refreshCardLine,
} from '../kanban/board.js'

// Mirrors a real Obsidian-Kanban file: blank line inside the frontmatter
// fence, blank lines between cards, strikethrough, trailing settings block.
const REAL_BOARD = `---

kanban-plugin: board

---

## Backlog

- [ ] Cancel Telnyx subscription

- [x] ~~Monzo API integration~~ — ACCESS REVOKED
- [ ] Evening digest @al
- [ ] Dispatched card @scribe ^abc123


## In Progress

- [ ] Migrate voice calls


## Done

- [x] Calendar-watcher created and deployed




%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%`

describe('isKanbanBoard', () => {
  it('detects the kanban-plugin frontmatter key', () => {
    expect(isKanbanBoard(REAL_BOARD)).toBe(true)
    expect(isKanbanBoard('---\ntitle: x\n---\n# hi')).toBe(false)
    expect(isKanbanBoard('no frontmatter')).toBe(false)
  })
})

describe('parseCardTokens', () => {
  it('plain text', () => {
    expect(parseCardTokens('Fix the thing')).toEqual({ text: 'Fix the thing', agentKey: null, blockId: null })
  })
  it('agent only', () => {
    expect(parseCardTokens('Fix the thing @al')).toEqual({ text: 'Fix the thing', agentKey: 'al', blockId: null })
  })
  it('agent + block id, either order', () => {
    expect(parseCardTokens('Fix @scribe ^abc123')).toEqual({ text: 'Fix', agentKey: 'scribe', blockId: 'abc123' })
    expect(parseCardTokens('Fix ^abc123 @scribe')).toEqual({ text: 'Fix', agentKey: 'scribe', blockId: 'abc123' })
  })
  it('mid-text @ / ^ are not tokens', () => {
    expect(parseCardTokens('Email alice@example.com about it')).toEqual({
      text: 'Email alice@example.com about it', agentKey: null, blockId: null,
    })
    expect(parseCardTokens('2^10 is 1024')).toEqual({ text: '2^10 is 1024', agentKey: null, blockId: null })
  })
})

describe('parseBoard / serializeBoard round-trip', () => {
  it('is lossless on a real plugin file', () => {
    expect(serializeBoard(parseBoard(REAL_BOARD))).toBe(REAL_BOARD)
  })

  it('parses columns, cards, assignment', () => {
    const board = parseBoard(REAL_BOARD)
    expect(board.columns.map((c) => c.title)).toEqual(['Backlog', 'In Progress', 'Done'])
    const backlog = board.columns[0]!
    expect(backlog.cards).toHaveLength(4)
    expect(backlog.cards[1]!.checked).toBe(true)
    expect(backlog.cards[2]!.agentKey).toBe('al')
    expect(backlog.cards[3]!).toMatchObject({ agentKey: 'scribe', blockId: 'abc123', text: 'Dispatched card' })
  })

  it('attaches indented continuation lines to their card', () => {
    const src = `---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Parent card\n  extra detail line\n- [ ] Next card\n`
    const board = parseBoard(src)
    expect(board.columns[0]!.cards[0]!.lines).toHaveLength(2)
    expect(serializeBoard(board)).toBe(src)
  })

  it('preserves an empty column', () => {
    const src = `---\nkanban-plugin: board\n---\n\n## Empty\n\n\n## Full\n\n- [ ] x\n`
    expect(serializeBoard(parseBoard(src))).toBe(src)
  })
})

describe('mutations', () => {
  it('moveCard moves + flips checked for done-columns, still serializes cleanly', () => {
    const board = parseBoard(REAL_BOARD)
    const ref = findCardByBlockId(board, 'abc123')!
    expect(ref).toEqual({ column: 'Backlog', index: 3 })
    expect(moveCard(board, ref, 'Done')).toBe(true)
    const done = board.columns.find((c) => c.title === 'Done')!
    const moved = done.cards[done.cards.length - 1]!
    expect(moved.checked).toBe(true)
    expect(moved.lines[0]).toBe('- [x] Dispatched card @scribe ^abc123')
    // Source column intact minus the card
    expect(board.columns[0]!.cards).toHaveLength(3)
    expect(serializeBoard(board)).toContain('## Done')
  })

  it('moveCard to a non-done column leaves checked alone', () => {
    const board = parseBoard(REAL_BOARD)
    const ref = findCardByBlockId(board, 'abc123')!
    moveCard(board, ref, 'In Progress')
    const inprog = board.columns.find((c) => c.title === 'In Progress')!
    expect(inprog.cards[inprog.cards.length - 1]!.checked).toBe(false)
  })

  it('addCard renders tokens', () => {
    const board = parseBoard(REAL_BOARD)
    const card = addCard(board, 'Backlog', 'New work', { agentKey: 'al', blockId: 'zz9' })!
    expect(card.lines[0]).toBe('- [ ] New work @al ^zz9')
    expect(serializeBoard(board)).toContain('- [ ] New work @al ^zz9')
  })

  it('refreshCardLine after stamping a block id', () => {
    const board = parseBoard(REAL_BOARD)
    const card = getCard(board, { column: 'Backlog', index: 2 })!
    expect(card.agentKey).toBe('al')
    card.blockId = 'fresh1'
    refreshCardLine(card)
    expect(card.lines[0]).toBe('- [ ] Evening digest @al ^fresh1')
  })
})
