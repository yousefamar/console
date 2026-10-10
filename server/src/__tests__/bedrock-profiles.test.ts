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
  knownProfiles, resetProfilesForTest, setBedrockProfileLogger, refreshFromAws, PROFILE_OWNER,
} = await import('../bedrock-profiles.js')

const ARN_RE = /^arn:aws:bedrock:us-east-1:\d{12}:application-inference-profile\/[a-z0-9]+(\[1m\])?$/
/** Strip the CLI's 1M context-hint suffix. */
const bare = (id: string) => id.replace(/\[1m\]$/, '')

beforeEach(() => {
  resetProfilesForTest()
  setBedrockProfileLogger(() => {})
  backend.current = 'bedrock'
})

describe('taggedModelId, forced onto Bedrock for a box with no Max login', () => {
  // 9 Oct 2026: the fleet moved to a Max login, forge forks were started with
  // the fleet's first-party `--model`, and all 21 answered "Not logged in".
  it('turns the fleet\'s first-party id into a profile ARN while the fleet is on Max', () => {
    backend.current = 'first_party'
    expect(taggedModelId('claude-opus-5-5')).toBe('claude-opus-5-5') // unforced: untouched, as before
    const forced = taggedModelId('claude-opus-5-5', { forceBedrock: true })
    expect(bare(forced)).toBe(knownProfiles()['us.anthropic.claude-opus-5-5'])
    expect(forced).toMatch(ARN_RE)
  })

  it('finds a dated id whose Bedrock name carries a version suffix', () => {
    backend.current = 'first_party'
    expect(bare(taggedModelId('claude-haiku-4-5-20251001', { forceBedrock: true })))
      .toBe(knownProfiles()['us.anthropic.claude-haiku-4-5-20251001-v1:0'])
  })

  it('never resolves one model to a longer-named sibling', () => {
    backend.current = 'first_party'
    // `claude-opus-5` must not prefix-match `…claude-opus-5-5`.
    expect(bare(taggedModelId('claude-opus-5', { forceBedrock: true }))).toBe(knownProfiles()['us.anthropic.claude-opus-5'])
  })

  it('never hands a first-party id to a Bedrock-only process, even with no profile for it', () => {
    backend.current = 'first_party'
    expect(taggedModelId('claude-nonesuch-9', { forceBedrock: true })).toBe('us.anthropic.claude-nonesuch-9')
  })

  it('leaves aliases and ARNs alone — the CLI resolves aliases from the env the spawn supplies', () => {
    backend.current = 'first_party'
    expect(taggedModelId('sonnet', { forceBedrock: true })).toBe('sonnet')
    const arn = 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/abc123'
    expect(taggedModelId(arn, { forceBedrock: true })).toBe(arn)
  })
})

describe('taggedModelId', () => {
  it('maps every id in the built-in table to a well-formed profile ARN', () => {
    const table = knownProfiles()
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(6)
    for (const [id, arn] of Object.entries(table)) {
      expect(arn, id).toMatch(ARN_RE)
      expect(bare(taggedModelId(id))).toBe(arn)
    }
  })

  it('omits the CLI [1m] hint by default so autocompact fires at ~180k', () => {
    // With the hint the CLI believed 1M and compacted at ~990k; sessions grew
    // to the ceiling and every >65-min wake rewrote 500k-1M of cache
    // (cost review 2026-09-30). Default is now the CLI's 200k belief.
    for (const id of [
      'us.anthropic.claude-opus-5',
      'us.anthropic.claude-fable-5-1',
      'us.anthropic.claude-sonnet-5',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ]) {
      expect(taggedModelId(id), id).not.toMatch(/\[1m\]$/)
    }
  })

  it('CONSOLE_CONTEXT_1M=1 restores the hint for 1M-window models only', () => {
    const prev = process.env.CONSOLE_CONTEXT_1M
    process.env.CONSOLE_CONTEXT_1M = '1'
    try {
      for (const id of [
        'us.anthropic.claude-opus-5',
        'us.anthropic.claude-fable-5-1',
        'us.anthropic.claude-fable-5',
        'us.anthropic.claude-opus-4-8',
        'us.anthropic.claude-opus-4-7',
        'us.anthropic.claude-sonnet-5',
      ]) {
        expect(taggedModelId(id), id).toMatch(/\[1m\]$/)
      }
      // Haiku is a real 200k model: no hint even when opted in.
      expect(taggedModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).not.toMatch(/\[1m\]$/)
      // The stale first-party pin form inherits the hint from its model too.
      expect(taggedModelId('claude-opus-4-8')).toMatch(/\[1m\]$/)
    } finally {
      if (prev === undefined) delete process.env.CONSOLE_CONTEXT_1M
      else process.env.CONSOLE_CONTEXT_1M = prev
    }
  })

  it('translates every model in the real Bedrock chain', async () => {
    // Read from auth-backend's own preset rather than a copy of it: a chain
    // entry with no profile bills UNTAGGED, and a hardcoded list here cannot
    // catch the entry someone adds tomorrow. (It did not catch opus-5-5 /
    // sonnet-5-5 on 2026-10-08, which is half of why this card existed.)
    const { BACKEND_PRESETS } = await vi.importActual<typeof import('../auth-backend.js')>('../auth-backend.js')
    for (const id of BACKEND_PRESETS.bedrock.chain) {
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
    // No alias carries the 1M hint by default (see withContextHint); the
    // Haiku-backed ones never do.
    for (const key of Object.keys(env)) expect(env[key], key).not.toMatch(/\[1m\]$/)
  })

  it('points ANTHROPIC_MODEL/OPUS at the chain head and SONNET at the newest sonnet', async () => {
    // The chain governs what a SESSION spawns with; these aliases govern what its
    // subagents, compaction and `--model sonnet` callers get. When they disagree
    // the fleet silently runs a generation behind itself — which is what happened
    // between 6 and 8 Oct 2026, with the chain on opus-5 and 5.5 already served.
    const { BACKEND_PRESETS } = await vi.importActual<typeof import('../auth-backend.js')>('../auth-backend.js')
    const chain = BACKEND_PRESETS.bedrock.chain
    const env = aliasProfileEnv()
    expect(bare(env.ANTHROPIC_MODEL!)).toBe(bare(taggedModelId(chain[0]!)))
    expect(bare(env.ANTHROPIC_DEFAULT_OPUS_MODEL!)).toBe(bare(taggedModelId(chain.find((m) => m.includes('opus'))!)))
    expect(bare(env.ANTHROPIC_DEFAULT_SONNET_MODEL!)).toBe(bare(taggedModelId(chain.find((m) => m.includes('sonnet'))!)))
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

describe('refreshFromAws', () => {
  const arn = (id: string) => `arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/${id}`
  const fm = (id: string) => `arn:aws:bedrock:us-east-1::foundation-model/${id}`
  const haiku55 = [{
    inferenceProfileName: 'amar-cc-haiku-5-5',
    inferenceProfileArn: arn('h55'),
    status: 'ACTIVE',
    models: [{ modelArn: fm('anthropic.claude-haiku-5-5') }],
  }]

  it('tries again after a failed listing and merges what the retry finds', async () => {
    // Every boot from 8 Sept to 10 Oct 2026 failed its one attempt (the hub was
    // busy past the timeout) and the profiles were never discovered.
    const log: string[] = []
    setBedrockProfileLogger((m) => log.push(m))
    let calls = 0
    const list = async () => { if (++calls === 1) throw new Error('aws exited cleanly but its output was discarded'); return haiku55 }
    expect(await refreshFromAws('amar', { list, retryMs: 0 })).toBe(3)
    expect(calls).toBe(2)
    expect(knownProfiles()['us.anthropic.claude-haiku-5-5']).toBe(arn('h55'))
    expect(log[0]).toContain('try 1 of 3')
    expect(log[0]).toContain('retrying')
  })

  it('gives up after its tries and keeps the built-in table', async () => {
    const log: string[] = []
    setBedrockProfileLogger((m) => log.push(m))
    const before = { ...knownProfiles() }
    let calls = 0
    expect(await refreshFromAws('amar', { list: async () => { calls++; throw new Error('no network') }, tries: 2, retryMs: 0 })).toBe(0)
    expect(calls).toBe(2)
    expect(knownProfiles()).toEqual(before)
    expect(log.at(-1)).toContain('using built-in table: no network')
  })
})
