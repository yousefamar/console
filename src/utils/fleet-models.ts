// ============================================================================
// The model ids the fleet picker offers, per auth backend.
//
// These mirror BACKEND_PRESETS in server/src/auth-backend.ts and live in their
// own module purely so a test can hold the two in step. This picker is the only
// place Yousef can move the fleet, so a model missing here is a model the fleet
// effectively cannot be put on however well the hub supports it — that was
// ^trim-duck: Bedrock served opus/sonnet 5.5 from 6 Oct 2026 and nothing offered
// them. The ids cannot be derived from the chain at runtime: the picker also
// keeps older models the chain has dropped, and the same model needs a different
// id per backend (the wrong form 400s).
//
// Haiku 5.5 is deliberately absent from the Bedrock list: Bedrock serves it, but
// CLI 2.1.292 answers `unrecognized_model` locally for every form of its id —
// including a valid owner-tagged profile ARN — so picking it could not spawn.
// ============================================================================

export const FIRST_PARTY_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

export const BEDROCK_MODELS = [
  'us.anthropic.claude-opus-5-5',
  'us.anthropic.claude-opus-5',
  'us.anthropic.claude-fable-5-1',
  'us.anthropic.claude-fable-5',
  'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7',
  'us.anthropic.claude-sonnet-5-5',
  'us.anthropic.claude-sonnet-5',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
] as const
