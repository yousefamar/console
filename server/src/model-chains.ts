// ============================================================================
// The per-backend model fallback chains, most-capable-first.
//
// Split out of auth-backend.ts (which pulls in node + AWS modules) purely so the
// SPA side can import the lists and a test can hold the fleet picker in step with
// them — see src/utils/fleet-models.ts. Keep this module dependency-free.
//
// Every id here is VERIFIED against its backend by a one-shot spawn; the same
// model needs a different id per backend (Bedrock wants `us.anthropic.*`, the Max
// subscription wants bare ids) and the wrong form 400s. The reasoning behind each
// chain's ORDER lives with the presets in auth-backend.ts.
// ============================================================================

/** Bedrock. opus-5-5 leads and sonnet-5-5 sits ahead of sonnet-5 — both
 *  spawn-verified 2026-10-08, as the bare `us.` id and as their owner-tagged
 *  profile ARN. Haiku stays on 4.5: Bedrock serves haiku-5-5, but CLI 2.1.292
 *  answers `unrecognized_model` locally for every form of its id. */
export const BEDROCK_CHAIN = [
  'us.anthropic.claude-opus-5-5',
  'us.anthropic.claude-opus-5',
  'us.anthropic.claude-fable-5-1',
  'us.anthropic.claude-fable-5',
  'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7',
  'us.anthropic.claude-sonnet-5-5',
  'us.anthropic.claude-sonnet-5',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
]

/** Claude Max subscription. No credit-metered model may lead this one — see the
 *  Fable incident recorded on the preset in auth-backend.ts. */
export const FIRST_PARTY_CHAIN = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]
