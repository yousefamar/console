// ============================================================================
// Model id → human label.
//
// A model id reaches the UI in four shapes for the same model: a bare
// first-party id (`claude-opus-5`), a Bedrock id (`us.anthropic.claude-opus-5`),
// a versioned one (`…-haiku-4-5-20251001-v1:0`), and — because the hub swaps in
// an owner-tagged application-inference-profile ARN at spawn time for cost
// attribution (server/src/bedrock-profiles.ts) — a raw ARN, which the CLI then
// reports back as the session's model. Pickers and status bars showed that ARN
// verbatim.
//
// Labelling is presentation-only: every value passed around stays the real id.
// The ARN case can't be reversed (the profile id carries no model name), so it
// resolves against the picker's own option list where one is available.
// ============================================================================

/** `us.anthropic.claude-haiku-4-5-20251001-v1:0` → `Haiku 4.5`. Returns null
 *  for anything that isn't a recognisable Claude id (ARNs included). */
export function modelLabel(id: string): string | null {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return null
  const family = m[1]!
  const label = family.charAt(0).toUpperCase() + family.slice(1)
  return `${label} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

/** True for a Bedrock application-inference-profile ARN — the tagged form the
 *  hub actually spawns with. */
export function isProfileArn(id: string): boolean {
  return id.startsWith('arn:aws:bedrock:')
}

/** Display string for a model id. `candidates` lets an ARN resolve to a name:
 *  the hub reports the ARN it spawned with, but the caller knows which id it
 *  asked for, so a single-candidate match wins. Falls back to the raw id so an
 *  unrecognised model is never rendered as blank. */
export function displayModel(id: string, candidates: readonly string[] = []): string {
  const direct = modelLabel(id)
  if (direct) return direct
  if (isProfileArn(id)) {
    const named = candidates.map((c) => modelLabel(c)).filter((l): l is string => l !== null)
    const unique = Array.from(new Set(named))
    if (unique.length === 1) return unique[0]!
    return 'Bedrock profile'
  }
  return id
}
