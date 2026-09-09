// Client port of the board parser must agree with server/src/kanban/board.ts
// on the model-pin grammar: `#model/<alias-or-id>` OR a bare alias shorthand
// (`#sonnet`), serialized back as the shorthand for aliases.
import { describe, it, expect } from 'vitest'
import { MODEL_ALIASES, modelToken, parseBoard, parseCardTokens, refreshCardLine, sanitizeCardText, serializeBoard, splitTrailingTags } from '@/kanban/board'

describe('client board port: model-pin shorthand', () => {
  it('bare #<alias> pins the model; other hashtags stay display tags', () => {
    expect(MODEL_ALIASES).toEqual(['opus', 'fable', 'sonnet', 'haiku'])
    expect(parseCardTokens('Quick fix #sonnet @al ^ab12')).toMatchObject({ text: 'Quick fix', agentKey: 'al', blockId: 'ab12', model: 'sonnet' })
    expect(parseCardTokens('Deep one #opus #inherit')).toMatchObject({ text: 'Deep one', inherit: true, model: 'opus' })
    expect(parseCardTokens('Explicit #model/haiku').model).toBe('haiku')
    expect(parseCardTokens('Canadian tax lines #rfp')).toMatchObject({ text: 'Canadian tax lines #rfp', model: null })
    expect(splitTrailingTags(parseCardTokens('Canadian tax lines #rfp').text).tags).toEqual(['rfp'])
    expect(parseCardTokens('The #sonnet form is nicer here').model).toBe(null)
  })

  it('serializes aliases as the shorthand and ids behind #model/; sanitizer guards both', () => {
    expect(modelToken('haiku')).toBe('#haiku')
    expect(modelToken('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('#model/us.anthropic.claude-haiku-4-5-20251001-v1:0')
    const board = parseBoard('## In Progress\n- [ ] Fix it #model/sonnet @al ^ab12\n- [ ] Keep #haiku @al\n')
    for (const c of board.columns[0]!.cards) refreshCardLine(c)
    expect(serializeBoard(board)).toBe('## In Progress\n- [ ] Fix it #sonnet @al ^ab12\n- [ ] Keep #haiku @al\n')
    expect(sanitizeCardText('we love #opus')).toBe('we love `#opus`')
    expect(sanitizeCardText('we love #rfp')).toBe('we love #rfp')
  })
})
