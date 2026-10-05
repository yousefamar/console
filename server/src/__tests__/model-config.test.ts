// ModelConfig + model-error detection. These pin the resilience behavior added
// after Anthropic pulled `claude-fable-5` and left the hub unrecoverable: a
// runtime-configurable model with an auto-advancing fallback chain.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfig, looksLikeModelError, DEFAULT_MODEL_CHAIN } from '../model-config.js'

let dir: string
let file: string
function fresh() { return new ModelConfig(file) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-config-'))
  file = join(dir, 'agent-model.json')
  delete process.env.CLAUDE_MODEL
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDE_MODEL
})

describe('looksLikeModelError', () => {
  it('matches model-unavailable phrasings', () => {
    for (const t of [
      'model claude-fable-5 not found',
      'The model "claude-fable-5" is no longer available',
      'invalid model: claude-fable-5',
      'unknown model claude-fable-5',
      'Error 404: model does not exist',
      'You do not have access to model claude-fable-5',
      'this model is deprecated',
    ]) {
      expect(looksLikeModelError(t), t).toBe(true)
    }
  })

  it('does NOT match unrelated errors', () => {
    for (const t of [
      'rate limit exceeded',
      'connection reset by peer',
      'tool execution failed',
      'file not found: /tmp/x',   // "not found" but no "model"
      '',
    ]) {
      expect(looksLikeModelError(t), t).toBe(false)
    }
  })
})

describe('ModelConfig defaults + persistence', () => {
  it('defaults to the head of the chain', () => {
    const c = fresh()
    expect(c.getModel()).toBe(DEFAULT_MODEL_CHAIN[0])
    expect(c.getChain()).toEqual(DEFAULT_MODEL_CHAIN)
    expect(c.getState().lockedByEnv).toBe(false)
  })

  it('persists a setModel across instances', () => {
    fresh().setModel('claude-sonnet-4-6')
    expect(fresh().getModel()).toBe('claude-sonnet-4-6')
  })

  it('setModel prepends an unknown model so it can still fall back', () => {
    const c = fresh()
    c.setModel('claude-some-new-model')
    expect(c.getModel()).toBe('claude-some-new-model')
    expect(c.getChain()[0]).toBe('claude-some-new-model')
    // fallback still works off the rest of the chain
    const r = c.reportFailure('claude-some-new-model')
    expect(r.changed).toBe(true)
    expect(r.model).toBe(DEFAULT_MODEL_CHAIN[0])
  })
})

describe('ModelConfig fallback', () => {
  it('advances to the next chain entry when the active model fails', () => {
    const c = fresh()
    const r = c.reportFailure(DEFAULT_MODEL_CHAIN[0]!)
    expect(r.changed).toBe(true)
    expect(r.model).toBe(DEFAULT_MODEL_CHAIN[1])
    expect(c.getModel()).toBe(DEFAULT_MODEL_CHAIN[1])
  })

  it('is idempotent for a stale (already-superseded) failure', () => {
    const c = fresh()
    c.reportFailure(DEFAULT_MODEL_CHAIN[0]!) // now on [1]
    const r = c.reportFailure(DEFAULT_MODEL_CHAIN[0]!) // stale report of [0]
    expect(r.changed).toBe(false)
    expect(c.getModel()).toBe(DEFAULT_MODEL_CHAIN[1])
  })

  it('reports exhausted at the end of the chain', () => {
    const c = fresh()
    c.setChain(['a', 'b'])
    expect(c.reportFailure('a').model).toBe('b')
    const r = c.reportFailure('b')
    expect(r.changed).toBe(false)
    expect(r.exhausted).toBe(true)
    expect(c.getModel()).toBe('b')
  })
})

describe('ModelConfig env override', () => {
  it('CLAUDE_MODEL wins and disables fallback', () => {
    const c = fresh()
    c.setModel('claude-sonnet-4-6')
    process.env.CLAUDE_MODEL = 'claude-haiku-4-5'
    expect(c.getModel()).toBe('claude-haiku-4-5')
    expect(c.getState().lockedByEnv).toBe(true)
    const r = c.reportFailure('claude-haiku-4-5')
    expect(r.changed).toBe(false) // env-locked: no auto-fallback
  })
})

describe('ModelConfig preset reconcile (^shy-kite)', () => {
  const OLD_MAX = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']
  const NEW_MAX = ['claude-fable-5-1', ...OLD_MAX]

  it('adopts a newer preset over an unedited copy of the old one, model follows the head', () => {
    fresh().applyPreset(OLD_MAX)
    const c = fresh()
    expect(c.reconcilePreset(NEW_MAX)).toBe(true)
    expect(c.getState()).toMatchObject({ model: 'claude-fable-5-1', chain: NEW_MAX })
    expect(fresh().getChain()).toEqual(NEW_MAX) // persisted
  })

  it('migrates a pre-presetChain file whose entries all sit in the new preset (the live 3 Oct state)', () => {
    writeFileSync(file, JSON.stringify({ model: 'claude-opus-5-5', chain: OLD_MAX }))
    const d = fresh()
    expect(d.reconcilePreset(NEW_MAX)).toBe(true)
    expect(d.getModel()).toBe('claude-fable-5-1')
  })

  it('keeps a stepped-down or human-picked model that is not the old head', () => {
    const c = fresh(); c.applyPreset(OLD_MAX); c.setModel('claude-sonnet-5')
    const d = fresh()
    expect(d.reconcilePreset(NEW_MAX)).toBe(true)
    expect(d.getModel()).toBe('claude-sonnet-5')
  })

  it('leaves a hand-edited chain alone, even a subset of the preset', () => {
    const c = fresh(); c.applyPreset(NEW_MAX); c.setChain(['claude-opus-5', 'claude-haiku-4-5-20251001'])
    expect(fresh().reconcilePreset(NEW_MAX)).toBe(false)
    expect(fresh().getChain()).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001'])
  })

  it('is a no-op when the chain already matches', () => {
    fresh().applyPreset(NEW_MAX)
    expect(fresh().reconcilePreset(NEW_MAX)).toBe(false)
  })
})
