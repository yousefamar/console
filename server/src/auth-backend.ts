// ============================================================================
// Auth backend switch — Claude Max subscription vs Amazon Bedrock.
//
// Why this exists: Yousef alternates between his Claude Max subscription
// (fixed-cost, but hits 5h/weekly session limits under fleet-wide agent load)
// and Amazon Bedrock (pay-per-token, no session limits, needs AWS credentials).
// Each `claude` CLI subprocess resolves its backend from `~/.claude/settings.json`
// `env` at its OWN spawn time (not from the hub's process env — confirmed: the
// hub's pm2 env carries no Bedrock/AWS keys). So switching backends is:
//   1. rewrite settings.json's env block to the target preset (this file), and
//   2. swap the model chain to the id format that backend accepts — Bedrock
//      wants `us.anthropic.*`-prefixed ids, first-party wants bare ids; the
//      same id 400s ("provided model identifier is invalid") on the other
//      backend. (routes/agents.ts calls ModelConfig for this part.)
// Both together, then respawn live sessions (routes/agents.ts
// restartAllSessionsForModel) — hibernated sessions need no action, they
// resolve the new backend/model fresh at their next wake.
//
// Presets are hardcoded (like DEFAULT_MODEL_CHAIN) rather than round-tripped
// through a backup file — reproducible or a stray edited/deleted backup can't
// break the switch. Re-verify ids with a one-shot spawn before editing either
// preset (availability differs per tier — see model-config.ts's own note).
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export type AuthBackend = 'first_party' | 'bedrock'

export interface BackendPreset {
  id: AuthBackend
  label: string
  /** Full `env` delta merged into settings.json for this backend. */
  env: Record<string, string>
  /** Model chain (most-capable-first), VERIFIED against this backend by a
   *  one-shot spawn sweep (see model-config.ts DEFAULT_MODEL_CHAIN comment). */
  chain: string[]
}

/** Every env key any preset manages. Switching strips keys in this set that
 *  aren't in the target preset, so bedrock -> first_party actually removes the
 *  AWS_ and ANTHROPIC_MODEL keys rather than leaving them alongside the new value. */
const MANAGED_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const

export const BACKEND_PRESETS: Record<AuthBackend, BackendPreset> = {
  first_party: {
    id: 'first_party',
    label: 'Claude Max subscription',
    env: {},
    chain: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'bedrock-amar',
      AWS_REGION: 'us-east-1',
      ANTHROPIC_MODEL: 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/3xne2d3e2z7v',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'us.anthropic.claude-fable-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/5we3084lce1f',
    },
    // opus-4-7 dropped from the first-party chain (not served on the Max sub);
    // kept here since it IS available on this Bedrock deployment.
    chain: [
      'us.anthropic.claude-fable-5',
      'us.anthropic.claude-opus-4-8',
      'us.anthropic.claude-opus-4-7',
      'us.anthropic.claude-sonnet-5',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ],
  },
}

function settingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** Pure: compute the next settings.json object for a backend switch. Exported
 *  for unit testing without touching the filesystem. */
export function computeSettingsWithBackend(current: Record<string, unknown>, backend: AuthBackend): Record<string, unknown> {
  const preset = BACKEND_PRESETS[backend]
  const env = { ...(current.env as Record<string, string> | undefined ?? {}) }
  for (const key of MANAGED_ENV_KEYS) delete env[key]
  Object.assign(env, preset.env)
  return { ...current, env }
}

/** Detect which backend is currently active by inspecting settings.json —
 *  the source of truth `claude` subprocesses themselves read. */
export function detectActiveBackend(): AuthBackend {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const env = (JSON.parse(raw).env ?? {}) as Record<string, unknown>
    return env.CLAUDE_CODE_USE_BEDROCK ? 'bedrock' : 'first_party'
  } catch {
    return 'first_party' // settings.json absent/unreadable — first-party has no required env
  }
}

/** Rewrite settings.json's env block to the target backend's preset. Atomic
 *  (tmp + rename) so a crash mid-write can't corrupt the file every `claude`
 *  invocation reads. Does NOT touch the model chain or respawn sessions —
 *  callers (routes/agents.ts) own that via ModelConfig + restartAllSessionsForModel. */
export function writeBackendSettings(backend: AuthBackend): void {
  const path = settingsPath()
  let current: Record<string, unknown> = {}
  if (existsSync(path)) {
    try { current = JSON.parse(readFileSync(path, 'utf-8')) } catch { /* start fresh on corrupt file */ }
  }
  const next = computeSettingsWithBackend(current, backend)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, path)
}
