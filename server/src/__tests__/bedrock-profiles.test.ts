// Bedrock cost-attribution translation layer.
//
// The stake here is real money going permanently unattributable: a bare model id
// bypasses the owner-tagged inference profile and Cost Explorer can never split
// that spend by person after the fact. So the tests pin both directions — a known
// model MUST become an ARN on Bedrock, and everything else MUST pass through
// unchanged (a wrong translation 400s the whole fleet).

import { describe, it, expect, beforeEach, vi } from 'vitest'

// `taggedModelId`/`smallFastModel` gate on the active backend, which is read from
// ~/.claude/settings.json on the real machine. Mock it so these tests don't depend
// on which backend the dev box happens to be on right now.
const backend = { current: 'bedrock' as 'bedrock' | 'first_party' }
vi.mock('../auth-backend.js', () => ({
  detectActiveBackend: () => backend.current,
}))

const {
  taggedModelId, smallFastModel, aliasProfileEnv, parseOwnedProfiles,
  knownProfiles, resetProfilesForTest, setBedrockProfileLogger, PROFILE_OWNER,
} = await import('../bedrock-profiles.js')

const ARN_RE = /^arn:aws:bedrock:us-east-1:\d{12}:application-inference-profile\/[a-z0-9]+$/

beforeEach(() => {
  resetProfilesForTest()
  setBedrockProfileLogger(() => {})
  backend.current = 'bedrock'
})

describe('taggedModelId', () => {
  it('maps every id in the built-in table to a well-formed profile ARN', () => {
    const table = knownProfiles()
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(6)
    for (const [id, arn] of Object.entries(table)) {
      expect(arn, id).toMatch(ARN_RE)
      expect(taggedModelId(id)).toBe(arn)
    }
  })

  it('translates the models the default Bedrock chain actually uses', () => {
    // These are the ids in auth-backend.ts's bedrock preset. A miss here is the
    // exact regression this module exists to prevent.
    for (const id of [
      'us.anthropic.claude-opus-5',
      'us.anthropic.claude-fable-5-1',
      'us.anthropic.claude-fable-5',
      'us.anthropic.claude-opus-4-8',
      'us.anthropic.claude-opus-4-7',
      'us.anthropic.claude-sonnet-5',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ]) {
      expect(taggedModelId(id), id).toMatch(ARN_RE)
    }
  })

  it('is inert off Bedrock — a profile ARN is invalid first-party', () => {
    backend.current = 'first_party'
    expect(taggedModelId('us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5')
    expect(taggedModelId('claude-opus-5')).toBe('claude-opus-5')
  })

  it('passes through an explicit ARN unchanged (someone pinned a profile)', () => {
    const arn = 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/zzzzzzzzzzzz'
    expect(taggedModelId(arn)).toBe(arn)
  })

  it('translates a stale first-party pin to the Bedrock profile', () => {
    // Per-session pins persist in the manifest, so a pin set while on the Max
    // subscription (`claude-opus-4-8`) survives a backend switch. Without the
    // `us.anthropic.` retry it would hit the alias branch and bill untagged.
    expect(taggedModelId('claude-opus-4-8')).toBe(taggedModelId('us.anthropic.claude-opus-4-8'))
    expect(taggedModelId('claude-opus-4-8')).toMatch(ARN_RE)
    expect(taggedModelId('claude-sonnet-5')).toMatch(ARN_RE)
  })

  it('passes through short aliases silently — env vars resolve those', () => {
    const logs: string[] = []
    setBedrockProfileLogger((m) => logs.push(m))
    expect(taggedModelId('haiku')).toBe('haiku')
    expect(taggedModelId('sonnet')).toBe('sonnet')
    expect(logs).toEqual([])
  })

  it('passes through empty input', () => {
    expect(taggedModelId('')).toBe('')
  })

  it('warns exactly once per unknown model, and names it', () => {
    const logs: string[] = []
    setBedrockProfileLogger((m) => logs.push(m))
    const unknown = 'us.anthropic.claude-brand-new-9'
    expect(taggedModelId(unknown)).toBe(unknown) // pass through, never invent an ARN
    expect(taggedModelId(unknown)).toBe(unknown)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(unknown)
    expect(logs[0]).toContain('UNATTRIBUTABLE')
    // The warning must be actionable — it carries the fix command.
    expect(logs[0]).toContain('create-inference-profile')
    expect(logs[0]).toContain(`${PROFILE_OWNER}-cc-`)
  })
})

describe('smallFastModel', () => {
  it('is the owner-tagged Haiku profile on Bedrock', () => {
    expect(smallFastModel()).toBe(knownProfiles()['us.anthropic.claude-haiku-4-5-20251001-v1:0'])
    expect(smallFastModel()).toMatch(ARN_RE)
  })

  it('is the plain alias off Bedrock', () => {
    backend.current = 'first_party'
    expect(smallFastModel()).toBe('haiku')
  })
})

describe('aliasProfileEnv', () => {
  it('points every CLI model alias at a profile ARN', () => {
    // These are what subagents, compaction, and `--model haiku` callers resolve
    // through — `--model` only overrides ANTHROPIC_MODEL, so missing one of these
    // leaks untagged spend even with the spawn path fixed.
    const env = aliasProfileEnv()
    for (const key of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
    ]) {
      expect(env[key], key).toMatch(ARN_RE)
    }
  })

  it('omits keys whose model has no profile rather than emitting a bad id', () => {
    // Simulate a table where only haiku is known (a bad ARN 400s the fleet, so an
    // absent key — falling back to the CLI's own default — is the safe failure).
    const only = parseOwnedProfiles([
      {
        inferenceProfileName: 'amar-cc-haiku',
        inferenceProfileArn: 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/aaaaaaaaaaaa',
        status: 'ACTIVE',
        models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0' }],
      },
    ], 'amar')
    expect(Object.keys(only)).toContain('us.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(only['anthropic.claude-haiku-4-5-20251001-v1:0']).toBe(only['us.anthropic.claude-haiku-4-5-20251001-v1:0'])
  })
})

describe('parseOwnedProfiles', () => {
  const arn = (id: string) => `arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/${id}`
  const fm = (id: string) => `arn:aws:bedrock:us-east-1::foundation-model/${id}`

  it('keys off the profile\'s own foundation model, not its name', () => {
    // Deliberately misleading name: the mapping must follow modelArn.
    const out = parseOwnedProfiles([{
      inferenceProfileName: 'amar-cc-whatever',
      inferenceProfileArn: arn('p1'),
      status: 'ACTIVE',
      models: [{ modelArn: fm('anthropic.claude-opus-5') }],
    }], 'amar')
    expect(out['us.anthropic.claude-opus-5']).toBe(arn('p1'))
  })

  it('registers bare, us. and global. prefix forms', () => {
    const out = parseOwnedProfiles([{
      inferenceProfileName: 'amar-cc-opus5',
      inferenceProfileArn: arn('p1'),
      status: 'ACTIVE',
      models: [{ modelArn: fm('anthropic.claude-opus-5') }],
    }], 'amar')
    expect(out).toEqual({
      'anthropic.claude-opus-5': arn('p1'),
      'us.anthropic.claude-opus-5': arn('p1'),
      'global.anthropic.claude-opus-5': arn('p1'),
    })
  })

  it('ignores other people\'s profiles — this hub bills to one owner', () => {
    const out = parseOwnedProfiles([
      {
        inferenceProfileName: 'sam-cc-opus5',
        inferenceProfileArn: arn('sam1'),
        status: 'ACTIVE',
        models: [{ modelArn: fm('anthropic.claude-opus-5') }],
      },
      {
        inferenceProfileName: 'guest1-cc-opus5',
        inferenceProfileArn: arn('g1'),
        status: 'ACTIVE',
        models: [{ modelArn: fm('anthropic.claude-opus-5') }],
      },
    ], 'amar')
    expect(out).toEqual({})
  })

  it('skips non-ACTIVE profiles (a deleting profile would 400)', () => {
    const out = parseOwnedProfiles([{
      inferenceProfileName: 'amar-cc-opus5',
      inferenceProfileArn: arn('p1'),
      status: 'DELETING',
      models: [{ modelArn: fm('anthropic.claude-opus-5') }],
    }], 'amar')
    expect(out).toEqual({})
  })

  it('treats a missing status as usable (the field is optional in the API)', () => {
    const out = parseOwnedProfiles([{
      inferenceProfileName: 'amar-cc-opus5',
      inferenceProfileArn: arn('p1'),
      models: [{ modelArn: fm('anthropic.claude-opus-5') }],
    }], 'amar')
    expect(out['us.anthropic.claude-opus-5']).toBe(arn('p1'))
  })

  it('is defensive about junk: no arn, no models, unparseable modelArn', () => {
    const out = parseOwnedProfiles([
      { inferenceProfileName: 'amar-cc-x', status: 'ACTIVE', models: [{ modelArn: fm('anthropic.claude-opus-5') }] },
      { inferenceProfileName: 'amar-cc-y', inferenceProfileArn: arn('p2'), status: 'ACTIVE' },
      { inferenceProfileName: 'amar-cc-z', inferenceProfileArn: arn('p3'), status: 'ACTIVE', models: [{ modelArn: 'garbage' }] },
      { inferenceProfileName: 'amar-cc-w', inferenceProfileArn: arn('p4'), status: 'ACTIVE', models: [{}] },
      {},
    ], 'amar')
    expect(out).toEqual({})
  })

  it('handles multiple models on one profile', () => {
    const out = parseOwnedProfiles([{
      inferenceProfileName: 'amar-cc-multi',
      inferenceProfileArn: arn('p1'),
      status: 'ACTIVE',
      models: [{ modelArn: fm('anthropic.claude-opus-5') }, { modelArn: fm('anthropic.claude-sonnet-5') }],
    }], 'amar')
    expect(out['us.anthropic.claude-opus-5']).toBe(arn('p1'))
    expect(out['us.anthropic.claude-sonnet-5']).toBe(arn('p1'))
  })
})
