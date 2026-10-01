import { describe, it, expect } from 'vitest'
import { resolveEffort, DEFAULT_EFFORT_POLICY, isEffort, EFFORTS } from '../agents/effort.js'
import { EFFORT_LEVELS } from '../kanban/board.js'

describe('resolveEffort', () => {
  it('generals / standing sessions / anything Yousef types into stay xhigh', () => {
    expect(resolveEffort({})).toEqual({ effort: 'xhigh', kind: 'default', reason: 'default' })
    expect(resolveEffort({ kind: 'default' })).toEqual({ effort: 'xhigh', kind: 'default', reason: 'default' })
    expect(resolveEffort({ kind: null })).toEqual({ effort: 'xhigh', kind: 'default', reason: 'default' })
  })

  it('throwaway workers — ticket forks, cron/listener --fork wakes, agent-chat forks — run high', () => {
    for (const kind of ['fork', 'cronFork', 'listenerFork', 'chatFork'] as const) {
      expect(resolveEffort({ kind })).toEqual({ effort: 'high', kind, reason: 'default' })
    }
  })

  it('the cache.effort pref overrides per kind, live, without touching the others', () => {
    const policy = { fork: 'medium', default: 'max' }
    expect(resolveEffort({ kind: 'fork', policy })).toEqual({ effort: 'medium', kind: 'fork', reason: 'pref' })
    expect(resolveEffort({ kind: 'default', policy })).toEqual({ effort: 'max', kind: 'default', reason: 'pref' })
    expect(resolveEffort({ kind: 'cronFork', policy })).toEqual({ effort: 'high', kind: 'cronFork', reason: 'default' })
  })

  it('an invalid or malformed pref falls back to the code default', () => {
    expect(resolveEffort({ kind: 'fork', policy: { fork: 'turbo' } }).effort).toBe('high')
    expect(resolveEffort({ kind: 'fork', policy: 'xhigh' }).effort).toBe('high')
    expect(resolveEffort({ kind: 'fork', policy: null }).effort).toBe('high')
    expect(resolveEffort({ kind: 'fork', policy: { fork: 7 } }).effort).toBe('high')
  })

  it('a card pin (#effort/<level>) beats both the pref and the default', () => {
    expect(resolveEffort({ kind: 'fork', pin: 'xhigh', policy: { fork: 'low' } })).toEqual({ effort: 'xhigh', kind: 'fork', reason: 'pinned' })
    expect(resolveEffort({ kind: 'default', pin: 'low' })).toEqual({ effort: 'low', kind: 'default', reason: 'pinned' })
  })

  it('an unknown pin is ignored, not passed to the CLI', () => {
    expect(resolveEffort({ kind: 'fork', pin: 'ultra' as never })).toEqual({ effort: 'high', kind: 'fork', reason: 'default' })
    expect(resolveEffort({ kind: 'fork', pin: null })).toEqual({ effort: 'high', kind: 'fork', reason: 'default' })
  })

  it('every default is a level the CLI accepts, and the board tag grammar matches', () => {
    for (const v of Object.values(DEFAULT_EFFORT_POLICY)) expect(isEffort(v)).toBe(true)
    expect([...EFFORT_LEVELS]).toEqual([...EFFORTS])
  })
})
