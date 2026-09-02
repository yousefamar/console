// ============================================================================
// Bedrock cost attribution — bare model id → owner-tagged inference profile.
//
// THE PROBLEM THIS SOLVES: on Bedrock, per-person cost attribution rides the
// `owner` cost-allocation tag, and the ONLY thing that carries a tag is an
// *application inference profile* (`<owner>-cc-<model>`, tagged `owner=<owner>`
// + `app=claude-code`). A request made against a bare model id
// (`us.anthropic.claude-opus-5`) routes straight to the foundation model,
// bypasses every profile, and lands in Cost Explorer permanently untagged —
// there is no retroactive fix. `session.ts` spawned every agent with
// `--model <bare id>`, and `--model` OVERRIDES `ANTHROPIC_MODEL` (which did
// point at a profile ARN), so ~99% of fleet spend was unattributable. Only
// Haiku attributed, via `ANTHROPIC_SMALL_FAST_MODEL` — no CLI flag overrides
// that one. (Proof, 2026-07-30: byOwner.amar === byModel['Claude Haiku 4.5'],
// to the microdollar.)
//
// THE FIX, and why it's a translation layer rather than a chain of ARNs:
// the model chain stays human-readable bare ids (`us.anthropic.claude-opus-5`)
// and we swap in the ARN at the last possible moment — the `--model` argv and
// the `set_model` control request. That keeps every id-shaped thing working:
// the SPA's model labels, `parseModelString`'s context-window table, the
// `looksLikeModelError` fallback chain, per-session pins, and `con agent model
// set`. An ARN-valued chain would have broken all of them at once.
//
// SELF-HEALING: the static table below is spawn-verified, but a model added to
// the chain later would silently regress to untagged. So `refreshFromAws()`
// enumerates the account's APPLICATION profiles at boot and merges anything it
// finds for this owner (keyed off each profile's own foundation-model ARN, not
// its name), and a translation MISS logs a loud one-shot warning naming the
// model — untagged spend announces itself instead of quietly accruing.
//
// A profile ARN is only valid on Bedrock, so translation is gated on the active
// backend (`detectActiveBackend`). On the Max subscription this module is inert.
// ============================================================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { detectActiveBackend } from './auth-backend.js'
import { nativeContextWindow } from './utils.js'

const execFileP = promisify(execFile)

/** Whose profiles this hub bills to. The hub's AWS identity is
 *  `claude-code-amar` (profile `bedrock-amar`), so all hub-spawned agent spend
 *  is Yousef's; other people run their own machines against their own
 *  `<owner>-cc-*` profiles. Overridable for a differently-owned deployment. */
export const PROFILE_OWNER = process.env.CONSOLE_BEDROCK_OWNER || 'amar'

const ACCOUNT = '637423377122'
const REGION = 'us-east-1'

function arn(id: string): string {
  return `arn:aws:bedrock:${REGION}:${ACCOUNT}:application-inference-profile/${id}`
}

/** Bare Bedrock model id → owner-tagged application-inference-profile ARN.
 *  Every entry spawn-verified end-to-end (`claude --model <arn> -p …` returned a
 *  real completion) on 2026-07-31 — a bad id 400s the whole fleet, so never add
 *  one from the console alone. Merged with `refreshFromAws()` at boot. */
const STATIC_PROFILES: Record<string, string> = {
  'us.anthropic.claude-opus-5': arn('oifqcw3zbemz'),
  'us.anthropic.claude-fable-5-1': arn('6cviuiy5tkry'),
  'us.anthropic.claude-fable-5': arn('3xne2d3e2z7v'),
  'us.anthropic.claude-opus-4-8': arn('m4smvy01am5l'),
  'us.anthropic.claude-opus-4-7': arn('4f0js9qp9ro0'),
  'us.anthropic.claude-sonnet-5': arn('56dbk0s0u5no'),
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': arn('5we3084lce1f'),
}

let profiles: Record<string, string> = { ...STATIC_PROFILES }
let logFn: (m: string) => void = () => {}
/** Models already warned about — one line per model, not one per spawn. */
const warned = new Set<string>()

export function setBedrockProfileLogger(fn: (m: string) => void): void {
  logFn = fn
}

/** True for something that is already a fully-qualified profile/model ARN. */
function isArn(id: string): boolean {
  return id.startsWith('arn:aws:bedrock:')
}

/**
 * The CLI's own 1M opt-in suffix, appended to the profile ARN for models whose
 * native window is 1M. On Bedrock the CLI only BELIEVES a model is 1M when its
 * catalog flags `native_1m_3p.bedrock` (Sonnet 5 alone, as of 2.1.257) — Fable
 * and Opus ≥ 4.7 are catalogued 1M but downgraded to a 200k belief here, so
 * `get_context_usage` reported `maxTokens: 200000` for sessions genuinely
 * holding 600k+ (live-verified 2026-09-02: the deployment serves 1M, and the
 * CLI's autocompact fired at ~990k). `[1m]` short-circuits that gate
 * (`PL(e)`: `if (Xc(e)) return 1e6`); the CLI strips it before the request.
 * Spawn-verified against every 1M profile in the table.
 */
function withContextHint(profileArn: string, model: string): string {
  return nativeContextWindow(model) === 1_000_000 ? `${profileArn}[1m]` : profileArn
}

/**
 * Translate a model id into this owner's tagged inference-profile ARN so the
 * resulting spend carries the `owner` cost-allocation tag.
 *
 * Pass-through cases (all deliberate, none of them errors):
 *  - not on the Bedrock backend — profile ARNs are meaningless first-party;
 *  - already an ARN — someone pinned a profile explicitly;
 *  - a short alias (`haiku`, `sonnet`) — those resolve via the
 *    `ANTHROPIC_DEFAULT_*_MODEL` env vars, which auth-backend.ts points at ARNs;
 *  - no profile for this model — WARNED, because it means untagged spend.
 */
export function taggedModelId(model: string): string {
  if (!model) return model
  if (isArn(model)) return model
  if (detectActiveBackend() !== 'bedrock') return model
  const hit = profiles[model]
  if (hit) return withContextHint(hit, model)
  // A first-party-shaped id (`claude-opus-4-8`) from a per-session pin that
  // predates the backend switch. Bedrock names the same model
  // `us.anthropic.claude-opus-4-8`, and without this it would fall through the
  // alias branch below and bill untagged forever.
  const bedrockForm = profiles[`us.anthropic.${model}`]
  if (bedrockForm) return withContextHint(bedrockForm, model)
  // Aliases are resolved by the CLI from env, which already points at ARNs.
  if (!model.includes('.')) return model
  if (!warned.has(model)) {
    warned.add(model)
    logFn(
      `[bedrock] WARNING: no owner-tagged inference profile for '${model}' — its spend will be UNATTRIBUTABLE. ` +
      `Create one: aws bedrock create-inference-profile --inference-profile-name ${PROFILE_OWNER}-cc-<label> ` +
      `--model-source copyFrom=arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${model} ` +
      `--tags key=owner,value=${PROFILE_OWNER} key=app,value=claude-code`,
    )
  }
  return model
}

/** Model id for the hub's own cheap one-shot `claude -p` calls (session-title
 *  generation, etc.). On Bedrock this is the owner-tagged Haiku profile ARN;
 *  elsewhere the plain `haiku` alias, which is the only form valid first-party.
 *  Passing the alias on Bedrock *would* resolve via `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
 *  but that indirection is invisible at the call site — being explicit means a
 *  future settings.json edit can't quietly un-attribute these calls. */
export function smallFastModel(): string {
  if (detectActiveBackend() !== 'bedrock') return 'haiku'
  return profiles['us.anthropic.claude-haiku-4-5-20251001-v1:0'] ?? 'haiku'
}

/** The ARNs auth-backend.ts bakes into settings.json for the CLI's own model
 *  aliases (subagents, compaction, and `--model haiku` callers like the
 *  session-title generator all resolve through these — `--model` only overrides
 *  `ANTHROPIC_MODEL`). Absent entries are simply omitted. */
export function aliasProfileEnv(): Record<string, string> {
  const pick = (id: string) => { const a = profiles[id]; return a ? withContextHint(a, id) : undefined }
  const env: Record<string, string> = {}
  const map: Array<[string, string]> = [
    ['ANTHROPIC_MODEL', 'us.anthropic.claude-opus-5'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'us.anthropic.claude-opus-5'],
    ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'us.anthropic.claude-fable-5-1'],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'us.anthropic.claude-sonnet-5'],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'],
    ['ANTHROPIC_SMALL_FAST_MODEL', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'],
  ]
  for (const [key, id] of map) {
    const a = pick(id)
    if (a) env[key] = a
  }
  return env
}

// ---------------------------------------------------------------------------
// Discovery (pure parse + the AWS call that feeds it)
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  inferenceProfileName?: string
  inferenceProfileArn?: string
  status?: string
  models?: Array<{ modelArn?: string }>
}

/**
 * Fold `aws bedrock list-inference-profiles --type-equals APPLICATION` into a
 * `bare model id → ARN` map for one owner.
 *
 * Keyed off each profile's own `models[].modelArn` rather than its name, so a
 * profile named anything at all still maps correctly — the name convention is
 * only used to decide WHOSE profile it is. Each foundation model is registered
 * under every prefix form the CLI might be handed (`us.`, `global.`, and bare),
 * because the chain uses `us.`-prefixed ids while AWS reports the unprefixed
 * foundation-model id.
 */
export function parseOwnedProfiles(summaries: ProfileSummary[], owner: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of summaries) {
    if (s.status && s.status !== 'ACTIVE') continue
    const name = s.inferenceProfileName ?? ''
    const profileArn = s.inferenceProfileArn
    if (!profileArn || !name.startsWith(`${owner}-`)) continue
    for (const m of s.models ?? []) {
      const modelArn = m.modelArn ?? ''
      const idx = modelArn.indexOf('foundation-model/')
      if (idx === -1) continue
      const fm = modelArn.slice(idx + 'foundation-model/'.length)
      if (!fm) continue
      out[fm] = profileArn
      out[`us.${fm}`] = profileArn
      out[`global.${fm}`] = profileArn
    }
  }
  return out
}

/** Merge AWS-discovered profiles over the static table. Best-effort: any
 *  failure (no creds, no network, CLI absent) leaves the verified static table
 *  in place, which is why translation never depends on this succeeding. */
export async function refreshFromAws(owner = PROFILE_OWNER): Promise<number> {
  try {
    const { stdout } = await execFileP('aws', [
      'bedrock', 'list-inference-profiles',
      '--type-equals', 'APPLICATION',
      '--max-results', '100',
      '--region', REGION,
      '--profile', process.env.CONSOLE_AWS_PROFILE || 'default',
      '--output', 'json',
    ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: process.env })
    const parsed = JSON.parse(stdout) as { inferenceProfileSummaries?: ProfileSummary[] }
    const found = parseOwnedProfiles(parsed.inferenceProfileSummaries ?? [], owner)
    const added = Object.keys(found).filter((k) => !profiles[k]).length
    // Discovered wins: AWS is the live truth if a profile was recreated.
    profiles = { ...profiles, ...found }
    // A model that now HAS a profile should be re-warnable if it ever loses one.
    for (const k of Object.keys(found)) warned.delete(k)
    logFn(`[bedrock] ${Object.keys(found).length} owner-tagged profile(s) for '${owner}' (${added} new)`)
    return added
  } catch (e) {
    logFn(`[bedrock] profile discovery failed, using built-in table: ${(e as Error).message}`)
    return 0
  }
}

/** Current translation table — for diagnostics / tests. */
export function knownProfiles(): Record<string, string> {
  return { ...profiles }
}

/** Test seam: restore the built-in table. */
export function resetProfilesForTest(): void {
  profiles = { ...STATIC_PROFILES }
  warned.clear()
}
