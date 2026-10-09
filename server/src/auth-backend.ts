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
import { aliasProfileEnv } from './bedrock-profiles.js'
import { loginDirs, MANAGED_ENV_KEYS } from './max-logins.js'
import { BEDROCK_CHAIN, FIRST_PARTY_CHAIN } from './model-chains.js'

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

export const BACKEND_PRESETS: Record<AuthBackend, BackendPreset> = {
  first_party: {
    id: 'first_party',
    label: 'Claude Max subscription',
    env: {},
    // opus-5-5 leads: the most capable model the Max plan covers at the flat
    // rate. Fable is deliberately NOT in this chain — on a subscription it has
    // its own small allowance and then "requires usage credits" (CLI 2.1.280
    // strings), i.e. the pay-per-use spend this chain exists to avoid; pin it
    // per session (`con agent model pin`) when a card warrants it. Every id
    // below is in the CLI's own model catalog (2.1.280); none is spawn-
    // verified against the Max account yet (its OAuth was expired when this
    // was written) — a 400 auto-advances the chain.
    // 3–6 Oct 2026, the round trip that proves the paragraph above: Fable was
    // put at the head on Yousef's "Fable is the default on Max" (cfbdc7b6) and
    // the plan's Fable credits were spent within three days. The rejection
    // arrives as `seven_day_overage_included` ("You're out of usage credits.
    // Switch to another model…"), which the failover read as a PLAN-wide
    // exhaustion and spilled the whole fleet to pay-per-token Bedrock for five
    // days — while probes showed opus-5-5 and haiku answering on Max the whole
    // time. Worse, `applyBackendSwitch` reseeds the chain FROM THIS PRESET, so
    // hand-fixing the live chain then switching back to Max put Fable straight
    // back and re-tripped in 3 s. Hence: the preset is the fix, and Fable stays
    // out until credits are bought deliberately (`con agent model pin` per
    // session if a card warrants it).
    chain: FIRST_PARTY_CHAIN,
  },
  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'bedrock-amar',
      AWS_REGION: 'us-east-1',
      // EVERY model alias points at an owner-tagged application inference
      // profile, not a bare model id — that tag is the only route to per-person
      // cost attribution, and `--model` only overrides `ANTHROPIC_MODEL`, so
      // these are what subagents, compaction, and `--model haiku` callers (e.g.
      // the session-title generator) resolve through. Generated from the
      // spawn-verified table in bedrock-profiles.ts rather than hardcoded here,
      // so a recreated profile can't leave a stale ARN behind. All ARNs
      // spawn-verified 2026-07-31. NB: resolved lazily by `presetEnv()`, not
      // spread here — this object literal is evaluated at module load, which is
      // BEFORE the boot-time AWS profile discovery, so a spread would freeze the
      // built-in table and miss anything discovered.
    },
    // opus-5-5 leads, sonnet-5-5 ahead of sonnet-5 — both spawn-verified on this
    // deployment 2026-10-08, as the bare `us.` id AND as their new owner-tagged
    // profile ARN. No marketplace agreement was needed this time: the 5-5
    // foundation models already answered for `claude-code-amar`, and the ONLY
    // thing missing was an `amar-cc-*` application inference profile — the fleet
    // sat on opus-5 for two days after 5.5 landed because this chain is
    // hand-maintained and nothing watches for a newer generation. If a model
    // here ever 403s "Model access is denied", that IS the marketplace-agreement
    // case: CreateFoundationModelAgreement via the `default`/user-amar profile,
    // which holds aws-marketplace:Subscribe (what opus-5 needed, 2026-07-25).
    // opus-4-7 kept (served on Bedrock, not on the Max sub).
    chain: BEDROCK_CHAIN,
  },
}

function settingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** Every settings.json the switch must rewrite: the canonical one plus one per
 *  registered Max login (max-logins.ts). With a single login this is exactly
 *  `[settingsPath()]`, as it always was. A login whose settings.json lagged
 *  would spawn on the wrong backend the moment the fleet rotated onto it. */
function settingsPaths(): string[] {
  return loginDirs().map((dir) => join(dir, 'settings.json'))
}

/** A preset's env, resolved AT CALL TIME. Bedrock's model-alias ARNs come from
 *  bedrock-profiles.ts, whose table is enriched by an async AWS lookup during
 *  boot — so they must be read when the switch is applied, not when this module
 *  was loaded. Exported for the unit tests. */
export function presetEnv(backend: AuthBackend): Record<string, string> {
  const preset = BACKEND_PRESETS[backend]
  return backend === 'bedrock' ? { ...preset.env, ...aliasProfileEnv() } : { ...preset.env }
}

/** Pure: compute the next settings.json object for a backend switch. Exported
 *  for unit testing without touching the filesystem. */
export function computeSettingsWithBackend(current: Record<string, unknown>, backend: AuthBackend): Record<string, unknown> {
  const env = { ...(current.env as Record<string, string> | undefined ?? {}) }
  for (const key of MANAGED_ENV_KEYS) delete env[key]
  Object.assign(env, presetEnv(backend))
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

/** The `env` block of settings.json — what every `claude` subprocess reads for
 *  its backend (AWS_PROFILE/AWS_REGION live here, not in the hub's own env). */
export function readSettingsEnv(): Record<string, string> {
  try {
    const env = JSON.parse(readFileSync(settingsPath(), 'utf-8')).env
    return env && typeof env === 'object' ? env as Record<string, string> : {}
  } catch {
    return {}
  }
}

/** Rewrite settings.json's env block to the target backend's preset. Atomic
 *  (tmp + rename) so a crash mid-write can't corrupt the file every `claude`
 *  invocation reads. Does NOT touch the model chain or respawn sessions —
 *  callers (routes/agents.ts) own that via ModelConfig + restartAllSessionsForModel. */
export function writeBackendSettings(backend: AuthBackend): void {
  let current: Record<string, unknown> = {}
  const canonical = settingsPath()
  if (existsSync(canonical)) {
    try { current = JSON.parse(readFileSync(canonical, 'utf-8')) } catch { /* start fresh on corrupt file */ }
  }
  // The canonical file is the source of truth for every login dir's copy, so a
  // dir that drifted converges here rather than keeping its own env.
  const body = JSON.stringify(computeSettingsWithBackend(current, backend), null, 2)
  for (const path of settingsPaths()) {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, path)
  }
}

/** Re-bake the ACTIVE backend's managed env at boot so settings.json tracks the
 *  code between switches — the alias ARNs (and their `[1m]` hints) otherwise only
 *  refresh on the next `con agent backend set`, and the file had drifted to a
 *  bare untagged `ANTHROPIC_DEFAULT_FABLE_MODEL`. Touches only MANAGED_ENV_KEYS;
 *  no-op (no write) when nothing differs. Returns the keys that changed. */
export function syncBackendSettings(): string[] {
  const path = settingsPath()
  let current: Record<string, unknown> = {}
  try { current = JSON.parse(readFileSync(path, 'utf-8')) } catch { return [] }
  const backend = detectActiveBackend()
  const before = (current.env as Record<string, string> | undefined) ?? {}
  const after = computeSettingsWithBackend(current, backend).env as Record<string, string>
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
  if (changed.length === 0) return []
  writeBackendSettings(backend)
  return changed
}
