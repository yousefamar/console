// Client port of the card-metadata grammar (server twin: card-meta.test.ts).
import { describe, it, expect } from 'vitest'
import { addCard, cardDisplay, parseBoard, parseCardTokens, refreshCardLine, serializeBoard } from '@/kanban/board'

const BOARD = `---
kanban-plugin: board
---

## Backlog

- [ ] Second idea #created-by/ui #requested-by:essam #haiku @eng ^aa11bb
- [ ] Stranded #created-by/ring #bi
`

describe('card metadata (client port)', () => {
  it('parses like the hub and round-trips untouched lines', () => {
    const board = parseBoard(BOARD)
    expect(serializeBoard(board)).toBe(BOARD)
    const card = board.columns[0]!.cards[0]!
    expect(card.text).toBe('Second idea')
    expect(card.meta).toEqual({ 'created-by': 'ui', 'requested-by': 'essam' })
    refreshCardLine(card)
    expect(card.lines[0]).toBe('- [ ] Second idea #created-by/ui #requested-by/essam #haiku @eng ^aa11bb')
    expect(parseCardTokens('Not a level #effort/turbo').meta).toEqual({})
  })

  it('cardDisplay labels metadata, keeps plain tags as badges, and rescues a stranded pair', () => {
    const [first, stranded] = parseBoard(BOARD).columns[0]!.cards
    expect(cardDisplay(first!)).toEqual({
      text: 'Second idea', tags: [],
      meta: [{ key: 'Created by', value: 'UI' }, { key: 'Requested by', value: 'essam' }],
    })
    expect(cardDisplay(stranded!)).toEqual({ text: 'Stranded', tags: ['bi'], meta: [{ key: 'Created by', value: 'Ring' }] })
  })

  it('a card cannot be added without a creator', () => {
    const board = parseBoard(BOARD)
    // @ts-expect-error — the type forbids it too
    expect(() => addCard(board, 'Backlog', 'Orphan')).toThrow(/needs a creator/)
    expect(addCard(board, 'Backlog', 'From the UI', { createdBy: 'ui', position: 'top' })!.lines[0]).toBe('- [ ] From the UI #created-by/ui')
  })
})
