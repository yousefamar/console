import { describe, it, expect } from 'vitest'
import { withReviewReminder, type AgentContext } from '../routes/agents.js'
import type { Session } from '../session.js'
import type { ReviewCardRef } from '../kanban/dispatch.js'

// The reminder is appended to what reaches the MODEL for a human message —
// the transcript keeps Yousef's words, and only sessions that own a card in
// Under Review are decorated.
function ctxWith(cards: Record<string, ReviewCardRef[]>): AgentContext {
  return {
    sessions: new Map(), clients: new Set(), cwd: '/tmp', log: () => {}, truncate: (s: string) => s, modelConfig: {},
    reviewCardsFor: (key: string) => cards[key] ?? [],
  } as unknown as AgentContext
}
const sess = (agentKey: string | undefined) => ({ agentKey }) as unknown as Session
const CARD: ReviewCardRef = { blockId: 'r1', text: 'Fix it', boardPath: 'projects/demo/board.md', project: 'demo' }

describe('withReviewReminder (^shy-boar)', () => {
  it('appends the move-back reminder for a session owning an Under-Review card', () => {
    const out = withReviewReminder(ctxWith({ eng: [CARD] }), sess('eng'), 'looks wrong on mobile')
    expect(out.startsWith('looks wrong on mobile\n')).toBe(true)
    expect(out).toContain('[BOARD — you own a card in Under Review]')
    expect(out).toContain('con spaces board demo move "^r1" "In Progress"')
  })

  it('leaves the text untouched when the session owns no review cards, has no key, or the hook is absent', () => {
    expect(withReviewReminder(ctxWith({ eng: [] }), sess('eng'), 'hi')).toBe('hi')
    expect(withReviewReminder(ctxWith({ eng: [CARD] }), sess(undefined), 'hi')).toBe('hi')
    const noHook = ctxWith({}); delete (noHook as { reviewCardsFor?: unknown }).reviewCardsFor
    expect(withReviewReminder(noHook, sess('eng'), 'hi')).toBe('hi')
  })

  it('never decorates /clear', () => {
    expect(withReviewReminder(ctxWith({ eng: [CARD] }), sess('eng'), ' /clear ')).toBe(' /clear ')
  })
})
