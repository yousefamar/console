import { describe, it, expect } from 'vitest'
import { parseModelString, nativeContextWindow, cwdToProjectDir } from '../utils.js'

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

  it('knows the native 1M window of current models without a bracket hint', () => {
    // Mirrors the CLI catalog: Fable/Mythos, Opus ≥ 4.7, Sonnet ≥ 5 are 1M.
    for (const id of [
      'claude-fable-5-1', 'us.anthropic.claude-fable-5', 'claude-opus-5',
      'us.anthropic.claude-opus-4-8', 'claude-opus-4-7', 'us.anthropic.claude-sonnet-5',
    ]) expect(parseModelString(id).contextWindow, id).toBe(1_000_000)
    for (const id of [
      'claude-opus-4-6', 'claude-sonnet-4-6', 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ]) expect(parseModelString(id).contextWindow, id).toBe(200_000)
  })

  it('a bracket hint on a profile ARN sets the window (the Bedrock spawn form)', () => {
    const arn = 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/6cviuiy5tkry'
    expect(parseModelString(`${arn}[1m]`).contextWindow).toBe(1_000_000)
    expect(parseModelString(arn).contextWindow).toBe(200_000)
  })
})

describe('nativeContextWindow', () => {
  it('returns null for ids it cannot classify', () => {
    expect(nativeContextWindow('arn:aws:bedrock:us-east-1:1:application-inference-profile/x')).toBeNull()
    expect(nativeContextWindow('haiku')).toBeNull()
    expect(nativeContextWindow('gpt-4')).toBeNull()
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
