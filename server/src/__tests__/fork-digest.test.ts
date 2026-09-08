import { describe, it, expect } from 'vitest'
import { buildParentDigest, extractExchanges, isMachinePrompt } from '../kanban/fork-digest.js'
import type { LoggableHubMessage } from '../protocol.js'

const S = 'session_1'
const user = (content: string): LoggableHubMessage => ({ type: 'user_prompt', sessionId: S, content })
const text = (content: string): LoggableHubMessage => ({ type: 'text', sessionId: S, content })
const tool = (): LoggableHubMessage => ({ type: 'tool_use', sessionId: S, toolUseId: 't', toolName: 'Bash', input: {} })

describe('isMachinePrompt', () => {
  it('bracketed hub envelopes, slash commands and blanks are machine traffic', () => {
    expect(isMachinePrompt('[BOARD TASK — action required]\nBoard: …')).toBe(true)
    expect(isMachinePrompt('[MERGE — fork "X" folded in and closed]')).toBe(true)
    expect(isMachinePrompt('  [pycaching upstream watch] Fetch …')).toBe(true)
    expect(isMachinePrompt('/clear')).toBe(true)
    expect(isMachinePrompt('   ')).toBe(true)
    expect(isMachinePrompt('Why is the hub model an old version of sonnet?')).toBe(false)
  })
})

describe('extractExchanges', () => {
  it('pairs each human prompt with the FIRST assistant text that follows, skipping machine prompts', () => {
    const log = [
      user('[MERGE — fork folded in]'), text('Absorbed.'),
      user('What map do we use?'), tool(), text('OpenFreeMap vector tiles.'), text('(second paragraph ignored)'),
      user('[BOARD TASK] card'), text('working…'),
      user('Kill the Projects session'), // no reply yet
    ]
    expect(extractExchanges(log)).toEqual([
      { prompt: 'What map do we use?', reply: 'OpenFreeMap vector tiles.' },
      { prompt: 'Kill the Projects session', reply: null },
    ])
  })

  it('keeps only the newest N exchanges and clamps long messages', () => {
    const log: LoggableHubMessage[] = []
    for (let i = 0; i < 12; i++) { log.push(user(`q${i} ${'x'.repeat(50)}`), text(`a${i} ${'y'.repeat(900)}`)) }
    const ex = extractExchanges(log, { maxExchanges: 3, promptChars: 10, replyChars: 12 })
    expect(ex.map((x) => x.prompt.slice(0, 3))).toEqual(['q9 ', 'q10', 'q11'])
    expect(ex[0]!.prompt.length).toBe(10)
    expect(ex[0]!.reply!.length).toBe(12)
    expect(ex[0]!.reply!.endsWith('…')).toBe(true)
  })
})

describe('buildParentDigest', () => {
  it('renders identity, open plan items and the conversation oldest-first', () => {
    const d = buildParentDigest([user('Why is Spaces empty?'), text('Bindings were clobbered — fixed.')], {
      parent: { name: 'Console general', agentKey: 'console-general', cwd: '/vault/projects/console' },
      todos: [{ subject: 'Ship X', status: 'in_progress' }, { subject: 'Done thing', status: 'completed' }],
    })!
    expect(d).toContain('Parent: Console general @console-general — cwd /vault/projects/console')
    expect(d).toContain("Parent's open plan items: Ship X")
    expect(d).not.toContain('Done thing')
    expect(d).toContain('- Yousef: Why is Spaces empty?')
    expect(d).toContain('↳ parent: Bindings were clobbered — fixed.')
  })

  it('returns null when nothing is worth carrying (only machine traffic, no identity)', () => {
    expect(buildParentDigest([user('[BOARD TASK] x'), text('ok')])).toBeNull()
    expect(buildParentDigest([])).toBeNull()
  })

  it('drops the OLDEST exchanges first to stay under maxChars, never the identity line', () => {
    const log: LoggableHubMessage[] = []
    for (let i = 0; i < 8; i++) log.push(user(`question number ${i} ${'q'.repeat(120)}`), text(`answer ${i} ${'a'.repeat(120)}`))
    const d = buildParentDigest(log, { maxChars: 700, parent: { name: 'P', agentKey: 'p' } })!
    expect(d.length).toBeLessThanOrEqual(700)
    expect(d.startsWith('Parent: P @p')).toBe(true)
    expect(d).toContain('question number 7')
    expect(d).not.toContain('question number 0')
  })

  it('folds multi-line messages onto one line per bullet', () => {
    const d = buildParentDigest([user('line one\nline two'), text('reply\n\nmore')])!
    expect(d).toContain('- Yousef: line one ⏎ line two')
    expect(d).toContain('↳ parent: reply ⏎ more')
  })
})
