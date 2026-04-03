import { describe, it, expect } from 'vitest'
import { parseModelString, cwdToProjectDir } from '../utils.js'

// --------------------------------------------------------------------------
// parseModelString
// --------------------------------------------------------------------------

describe('parseModelString', () => {
  it('parses opus model with 1m context bracket', () => {
    const result = parseModelString('claude-opus-4-6[1m]')
    expect(result.displayName).toBe('opus 4.6 [1M]')
    expect(result.contextWindow).toBe(1_000_000)
  })

  it('parses sonnet model with 200k context bracket', () => {
    const result = parseModelString('claude-sonnet-4-6[200k]')
    expect(result.displayName).toBe('sonnet 4.6 [200K]')
    expect(result.contextWindow).toBe(200_000)
  })

  it('parses haiku model without bracket (defaults to 200k)', () => {
    const result = parseModelString('claude-haiku-4-5')
    expect(result.displayName).toBe('haiku 4.5')
    expect(result.contextWindow).toBe(200_000)
  })

  it('returns unknown for undefined model', () => {
    const result = parseModelString(undefined)
    expect(result.displayName).toBe('unknown')
    expect(result.contextWindow).toBe(200_000)
  })

  it('handles uppercase bracket hints', () => {
    const result = parseModelString('claude-opus-4-6[1M]')
    expect(result.displayName).toBe('opus 4.6 [1M]')
    expect(result.contextWindow).toBe(1_000_000)
  })

  it('passes through non-claude model strings as-is', () => {
    const result = parseModelString('gpt-4')
    expect(result.displayName).toBe('gpt-4')
    expect(result.contextWindow).toBe(200_000)
  })
})

// --------------------------------------------------------------------------
// cwdToProjectDir
// --------------------------------------------------------------------------

describe('cwdToProjectDir', () => {
  it('encodes a typical project path', () => {
    expect(cwdToProjectDir('/home/amar/proj/code/console')).toBe('-home-amar-proj-code-console')
  })

  it('encodes a short home path', () => {
    expect(cwdToProjectDir('/home/amar')).toBe('-home-amar')
  })

  it('encodes root path', () => {
    expect(cwdToProjectDir('/')).toBe('-')
  })

  it('encodes deeply nested path', () => {
    expect(cwdToProjectDir('/a/b/c/d/e')).toBe('-a-b-c-d-e')
  })
})
