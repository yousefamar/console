import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSettingsWithBackend, BACKEND_PRESETS } from '../auth-backend.js'

describe('computeSettingsWithBackend', () => {
  it('bedrock preset adds the Bedrock env keys', () => {
    const next = computeSettingsWithBackend({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }, 'bedrock')
    const env = next.env as Record<string, string>
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.AWS_PROFILE).toBe('bedrock-amar')
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.ANTHROPIC_MODEL).toMatch(/^arn:aws:bedrock:/)
    // Untouched keys survive
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
  })

  it('first_party preset REMOVES Bedrock env keys, not just leaves them', () => {
    const bedrockEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'bedrock-amar',
      AWS_REGION: 'us-east-1',
      ANTHROPIC_MODEL: 'arn:aws:bedrock:us-east-1:...:profile/x',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'us.anthropic.claude-fable-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'arn:aws:bedrock:us-east-1:...:profile/y',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    }
    const next = computeSettingsWithBackend({ env: bedrockEnv }, 'first_party')
    const env = next.env as Record<string, string>
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.AWS_PROFILE).toBeUndefined()
    expect(env.AWS_REGION).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
    // Unrelated key survives
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
  })

  it('strips stray managed keys not covered by the target preset (e.g. an ad-hoc ANTHROPIC_DEFAULT_SONNET_MODEL)', () => {
    // Regression: a manual edit added ANTHROPIC_DEFAULT_SONNET_MODEL /
    // ANTHROPIC_DEFAULT_HAIKU_MODEL that neither preset declares — these must
    // still be cleared on a first_party switch, not accumulate forever.
    const next = computeSettingsWithBackend({
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    }, 'first_party')
    const env = next.env as Record<string, string>
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  })

  it('is idempotent — applying the same backend twice yields the same env', () => {
    const once = computeSettingsWithBackend({}, 'bedrock')
    const twice = computeSettingsWithBackend(once, 'bedrock')
    expect(twice.env).toEqual(once.env)
  })

  it('preserves non-env top-level settings.json fields untouched', () => {
    const next = computeSettingsWithBackend({ someOtherSetting: { nested: true } }, 'bedrock')
    expect(next.someOtherSetting).toEqual({ nested: true })
  })
})

describe('BACKEND_PRESETS chains', () => {
  it('bedrock chain ids are us.anthropic.-prefixed (Bedrock naming)', () => {
    for (const id of BACKEND_PRESETS.bedrock.chain) {
      expect(id.startsWith('us.anthropic.')).toBe(true)
    }
  })

  it('first_party chain ids are bare (no provider prefix)', () => {
    for (const id of BACKEND_PRESETS.first_party.chain) {
      expect(id.startsWith('us.anthropic.')).toBe(false)
    }
  })

  it('chains are non-empty and most-capable-first (fable-5 leads both)', () => {
    expect(BACKEND_PRESETS.bedrock.chain[0]).toContain('fable-5')
    expect(BACKEND_PRESETS.first_party.chain[0]).toContain('fable-5')
  })
})

describe('detectActiveBackend + writeBackendSettings (filesystem)', () => {
  let dir: string
  let originalHome: string | undefined

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips: write bedrock then detect reads it back as bedrock', async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-backend-'))
    originalHome = process.env.HOME
    process.env.HOME = dir
    // Re-import with the new HOME so settingsPath() resolves under the temp dir.
    // (homedir() reads process.env.HOME at call time on POSIX, so no need to
    // reset modules — just re-invoke the functions.)
    const mod = await import('../auth-backend.js')
    mod.writeBackendSettings('bedrock')
    expect(mod.detectActiveBackend()).toBe('bedrock')

    const raw = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'))
    expect(raw.env.CLAUDE_CODE_USE_BEDROCK).toBe('1')

    mod.writeBackendSettings('first_party')
    expect(mod.detectActiveBackend()).toBe('first_party')
    const raw2 = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'))
    expect(raw2.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  })

  it('preserves unrelated settings.json content across a write', async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-backend-'))
    originalHome = process.env.HOME
    process.env.HOME = dir
    const mod = await import('../auth-backend.js')
    const settingsFile = join(dir, '.claude', 'settings.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(settingsFile, JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, someFlag: true }))
    mod.writeBackendSettings('bedrock')
    const raw = JSON.parse(readFileSync(settingsFile, 'utf-8'))
    expect(raw.someFlag).toBe(true)
    expect(raw.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(raw.env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  })

  it('detectActiveBackend defaults to first_party when settings.json is absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-backend-'))
    originalHome = process.env.HOME
    process.env.HOME = dir
    const mod = await import('../auth-backend.js')
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false)
    expect(mod.detectActiveBackend()).toBe('first_party')
  })
})
