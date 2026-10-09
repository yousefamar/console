// Client port of the board parser must agree with server/src/kanban/board.ts
// on the model-pin grammar: `#model/<alias-or-id>` OR a bare alias shorthand
// (`#sonnet`), serialized back as the shorthand for aliases.
import { describe, it, expect } from 'vitest'
import { MODEL_ALIASES, boardRemote, modelToken, parseBoard, parseCardTokens, refreshCardLine, sanitizeCardText, serializeBoard, splitTrailingTags } from '@/kanban/board'

describe('client board port: model-pin shorthand', () => {
  it('bare #<alias> pins the model; other hashtags stay display tags', () => {
    expect(MODEL_ALIASES).toEqual(['opus', 'fable', 'sonnet', 'haiku'])
    expect(parseCardTokens('Quick fix #sonnet @al ^ab12')).toMatchObject({ text: 'Quick fix', agentKey: 'al', blockId: 'ab12', model: 'sonnet', effort: null })
    expect(parseCardTokens('Deep one #opus #inherit')).toMatchObject({ text: 'Deep one', inherit: true, model: 'opus', effort: null })
    expect(parseCardTokens('Explicit #model/haiku').model).toBe('haiku')
    expect(parseCardTokens('Canadian tax lines #rfp')).toMatchObject({ text: 'Canadian tax lines #rfp', model: null, effort: null })
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

describe('client board port: #forge / #local placement', () => {
  it('parses the tag in any trailing position and leaves prose alone', () => {
    expect(parseCardTokens('Heavy build #forge @al ^ab12')).toMatchObject({ text: 'Heavy build', remote: 'forge', agentKey: 'al', blockId: 'ab12' })
    expect(parseCardTokens('Needs the desktop #nofork #local #opus')).toMatchObject({ text: 'Needs the desktop', remote: 'local', nofork: true, model: 'opus' })
    expect(parseCardTokens('Plain card').remote).toBe(null)
    expect(parseCardTokens('Run it #local first').remote).toBe(null)
    // Every token at once: the loop must be long enough to strip all eight.
    expect(parseCardTokens('All #haiku #effort/low #local #nofork #inherit #blocked @al ^ab12')).toMatchObject({
      text: 'All', model: 'haiku', effort: 'low', remote: 'local', nofork: true, inherit: true, blocked: true, agentKey: 'al', blockId: 'ab12',
    })
  })

  it('writes the tag where the server does, so an optimistic line matches the saved one', () => {
    const board = parseBoard('## Backlog\n- [ ] Fix it #local #effort/xhigh #sonnet @al ^ab12\n- [ ] Other ^cd34\n')
    const [a, b] = board.columns[0]!.cards
    refreshCardLine(a!)
    b!.remote = 'forge'
    refreshCardLine(b!)
    expect(serializeBoard(board)).toBe('## Backlog\n- [ ] Fix it #sonnet #effort/xhigh #local @al ^ab12\n- [ ] Other #forge ^cd34\n')
    b!.remote = null
    refreshCardLine(b!)
    expect(b!.lines[0]).toBe('- [ ] Other ^cd34')
    expect(sanitizeCardText('keep this one #local')).toBe('keep this one `#local`')
  })

  it('reads the board default from frontmatter; a typo is not a target', () => {
    expect(boardRemote('---\nkanban-plugin: board\nremote: forge\n---\n\n## Backlog\n')).toBe('forge')
    expect(boardRemote('---\nremote: local\n---\n')).toBe('local')
    expect(boardRemote('---\nremote: forrge\n---\n')).toBe(null)
    expect(boardRemote('---\nkanban-plugin: board\n---\n')).toBe(null)
    expect(boardRemote('## Backlog\nremote: forge\n')).toBe(null)
  })
})
