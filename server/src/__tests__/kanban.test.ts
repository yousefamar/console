import { describe, it, expect } from 'vitest'
import {
  cardUrls,
  isKanbanBoard, parseCardTokens, parseBoard, serializeBoard, sanitizeCardText, cardImagePaths, splitTrailingTags,
  findCardByBlockId, getCard, moveCard, addCard, refreshCardLine,
  boardDefaultOwner, setBoardDefaultOwner,
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
    expect(parseCardTokens('Fix the thing')).toEqual({ text: 'Fix the thing', agentKey: null, blockId: null, blocked: false, nofork: false, model: null })
  })
  it('agent only', () => {
    expect(parseCardTokens('Fix the thing @al')).toEqual({ text: 'Fix the thing', agentKey: 'al', blockId: null, blocked: false, nofork: false, model: null })
  })
  it('agent + block id, either order', () => {
    expect(parseCardTokens('Fix @scribe ^abc123')).toEqual({ text: 'Fix', agentKey: 'scribe', blockId: 'abc123', blocked: false, nofork: false, model: null })
    expect(parseCardTokens('Fix ^abc123 @scribe')).toEqual({ text: 'Fix', agentKey: 'scribe', blockId: 'abc123', blocked: false, nofork: false, model: null })
  })
  it('mid-text @ / ^ are not tokens', () => {
    expect(parseCardTokens('Email alice@example.com about it')).toEqual({
      text: 'Email alice@example.com about it', agentKey: null, blockId: null, blocked: false, nofork: false, model: null,
    })
    expect(parseCardTokens('2^10 is 1024')).toEqual({ text: '2^10 is 1024', agentKey: null, blockId: null, blocked: false, nofork: false, model: null })
  })
  it('#nofork is a trailing property; blocked/nofork/key/id compose', () => {
    expect(parseCardTokens('Fix it #nofork @al ^abc123')).toEqual({ text: 'Fix it', agentKey: 'al', blockId: 'abc123', blocked: false, nofork: true, model: null })
    expect(parseCardTokens('Fix it #nofork #blocked @al')).toEqual({ text: 'Fix it', agentKey: 'al', blockId: null, blocked: true, nofork: true, model: null })
    expect(parseCardTokens('The #nofork policy is fine')).toEqual({ text: 'The #nofork policy is fine', agentKey: null, blockId: null, blocked: false, nofork: false, model: null })
    expect(parseCardTokens('Quick fix #model/haiku @al ^ab12')).toEqual({ text: 'Quick fix', agentKey: 'al', blockId: 'ab12', blocked: false, nofork: false, model: 'haiku' })
    expect(parseCardTokens('Pin full id #model/us.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({ text: 'Pin full id', agentKey: null, blockId: null, blocked: false, nofork: false, model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' })
    expect(parseCardTokens('Discussing the #model/haiku tag here today')).toEqual({ text: 'Discussing the #model/haiku tag here today', agentKey: null, blockId: null, blocked: false, nofork: false, model: null })
  })
  it('#blocked is a trailing property, any order with other tokens', () => {
    expect(parseCardTokens('Fix it #blocked @al ^abc123')).toEqual({ text: 'Fix it', agentKey: 'al', blockId: 'abc123', blocked: true, nofork: false, model: null })
    expect(parseCardTokens('Fix it @al #blocked')).toEqual({ text: 'Fix it', agentKey: 'al', blockId: null, blocked: true, nofork: false, model: null })
    expect(parseCardTokens('The #blocked drain is fine')).toEqual({ text: 'The #blocked drain is fine', agentKey: null, blockId: null, blocked: false, nofork: false, model: null })
  })
})

describe('splitTrailingTags (display badges)', () => {
  it('splits a trailing tag run, preserves order', () => {
    expect(splitTrailingTags('Ship the digest #bi #email')).toEqual({ text: 'Ship the digest', tags: ['bi', 'email'] })
  })
  it('mid-text hashtags are prose, not tags', () => {
    expect(splitTrailingTags('The #blocked drain and #bi stuff need work')).toEqual({ text: 'The #blocked drain and #bi stuff need work', tags: [] })
  })
  it('no tags → identity', () => {
    expect(splitTrailingTags('Plain card')).toEqual({ text: 'Plain card', tags: [] })
  })
})

describe('sanitizeCardText (write-path token-collision guard)', () => {
  it('backtick-wraps a trailing #blocked so it survives a round-trip as prose', () => {
    expect(sanitizeCardText('UI like #blocked')).toBe('UI like `#blocked`')
  })
  it('handles @key and ^id tails; one wrap suffices (earlier tokens become mid-text)', () => {
    expect(sanitizeCardText('ping @al')).toBe('ping `@al`')
    expect(sanitizeCardText('see ^abc123')).toBe('see `^abc123`')
    // Only the TAIL parses as a token — once wrapped, "@al" is mid-text and
    // parseCardTokens never touches it.
    expect(sanitizeCardText('both @al #blocked')).toBe('both @al `#blocked`')
    const round = parseCardTokens(sanitizeCardText('both @al #blocked'))
    expect(round).toEqual({ text: 'both @al `#blocked`', agentKey: null, blockId: null, blocked: false, nofork: false, model: null })
  })
  it('leaves mid-text and non-token tails alone', () => {
    expect(sanitizeCardText('email alice@example.com')).toBe('email alice@example.com')
    expect(sanitizeCardText('#blocked at the start')).toBe('#blocked at the start')
    expect(sanitizeCardText('normal card')).toBe('normal card')
  })
  it('LIVE REPRO: addCard with token-tailed text round-trips losslessly', () => {
    const board = parseBoard(REAL_BOARD)
    addCard(board, 'Backlog', 'opt-out UI like #blocked')
    const reparsed = parseBoard(serializeBoard(board))
    const card = reparsed.columns[0]!.cards.find((c) => c.text.includes('opt-out'))!
    expect(card.blocked).toBe(false)
    expect(card.text).toBe('opt-out UI like `#blocked`')
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

describe('cardImagePaths', () => {
  it('extracts markdown-image detail lines, ignores text lines', () => {
    const board = parseBoard(`---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Card with images @al ^ab12cd\n  some detail text\n  ![img](images/card-1.png)\n  ![screenshot](images/shot.jpg)\n`)
    const card = board.columns[0]!.cards[0]!
    expect(cardImagePaths(card)).toEqual(['images/card-1.png', 'images/shot.jpg'])
  })

  it('empty for a card with no image lines', () => {
    const board = parseBoard(`---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Plain card\n  just text\n`)
    expect(cardImagePaths(board.columns[0]!.cards[0]!)).toEqual([])
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

  it("addCard position:'top' puts the card first, below the heading separator", () => {
    const board = parseBoard(REAL_BOARD)
    addCard(board, 'Backlog', 'Newest thing', { position: 'top' })
    const backlog = board.columns[0]!
    expect(backlog.cards[0]!.text).toBe('Newest thing')
    // The blank line under `## Backlog` must stay ABOVE the new card.
    const out = serializeBoard(board)
    expect(out).toContain('## Backlog\n\n- [ ] Newest thing')
    // Existing card interstitials still follow their cards (round-trip sane).
    expect(out).toContain('- [ ] Cancel Telnyx subscription\n\n- [x]')
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

describe('cardUrls', () => {
  const card = (lines: string[]) => ({ text: '', checked: false, agentKey: null, blockId: null, blocked: false, nofork: false, lines }) as never

  it('extracts bare URLs with hostname labels, strips clinging punctuation', () => {
    expect(cardUrls(card(['- [ ] see https://vercel.app/preview-abc.', '  and https://www.example.com/x,']))).toEqual([
      { url: 'https://vercel.app/preview-abc', label: 'vercel.app' },
      { url: 'https://www.example.com/x', label: 'example.com' },
    ])
  })

  it('markdown links use their label and are not double-counted', () => {
    expect(cardUrls(card(['- [ ] [preview](https://x.dev/p) and https://x.dev/p']))).toEqual([
      { url: 'https://x.dev/p', label: 'preview' },
    ])
  })

  it('image lines are excluded (thumbnails own those)', () => {
    expect(cardUrls(card(['- [ ] card', '  ![img](https://cdn.example.com/a.png)']))).toEqual([])
  })
})

describe('setBoardDefaultOwner (frontmatter default_owner)', () => {
  const owner = (b: ReturnType<typeof parseBoard>) => boardDefaultOwner(serializeBoard(b))

  it('inserts inside an existing fence, replaces, clears — columns untouched', () => {
    const board = parseBoard(REAL_BOARD)
    expect(owner(board)).toBeNull()
    setBoardDefaultOwner(board, 'demo-general')
    expect(owner(board)).toBe('demo-general')
    // Inserted before the closing fence, not after it.
    const close = board.header.indexOf('---', 1)
    expect(board.header.indexOf('default_owner: demo-general')).toBeLessThan(close)
    setBoardDefaultOwner(board, 'other')
    expect(owner(board)).toBe('other')
    expect(board.header.filter((l) => l.startsWith('default_owner:'))).toHaveLength(1)
    setBoardDefaultOwner(board, null)
    expect(owner(board)).toBeNull()
    // Everything else round-trips byte-identically.
    expect(serializeBoard(board)).toBe(serializeBoard(parseBoard(REAL_BOARD)))
  })

  it('prepends a fence on a board without frontmatter; clearing a missing owner is a no-op', () => {
    const board = parseBoard('## Backlog\n\n- [ ] x\n')
    setBoardDefaultOwner(board, null)
    expect(serializeBoard(board)).toBe('## Backlog\n\n- [ ] x\n')
    setBoardDefaultOwner(board, 'k')
    expect(serializeBoard(board).startsWith('---\ndefault_owner: k\n---\n')).toBe(true)
    expect(owner(board)).toBe('k')
  })
})
