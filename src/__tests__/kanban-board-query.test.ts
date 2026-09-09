// `findCardByQuery` resolves the same card address the /board/* API takes —
// `^id` for a stamped card, else the exact text — so a request handed across
// panes (Inbox → Spaces card modal) lands on the same card the hub would.
import { describe, it, expect } from 'vitest'
import { findCardByQuery, parseBoard } from '@/kanban/board'

const board = parseBoard([
  '---', '', 'kanban-plugin: board', '', '---',
  '## Backlog', '- [ ] Unstamped idea',
  '## Under Review', '- [ ] Ship the thing @console-general-glad-bee-fork ^glad-bee', '  - detail line',
  '## Done', '- [x] Old one ^old-one',
].join('\n'))

describe('findCardByQuery', () => {
  it('resolves a ^id to its column + index + card', () => {
    const hit = findCardByQuery(board, '^glad-bee')
    expect(hit?.ref).toEqual({ column: 'Under Review', index: 0 })
    expect(hit?.card.text).toBe('Ship the thing')
    expect(hit?.card.lines).toHaveLength(2)
  })

  it('falls back to exact text for an unstamped card; misses return null', () => {
    expect(findCardByQuery(board, 'Unstamped idea')?.ref).toEqual({ column: 'Backlog', index: 0 })
    expect(findCardByQuery(board, ' ^old-one ')?.ref.column).toBe('Done')
    expect(findCardByQuery(board, '^nope')).toBeNull()
    expect(findCardByQuery(board, 'Unstamped')).toBeNull()
  })
})
