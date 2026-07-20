// ============================================================================
// Transient API-error detection + auto-resume policy.
//
// Rate limits (429), overloaded upstreams (503/529), and gateway hiccups kill
// an agent's turn but resolve on their own — the session is healthy, the
// world just needs a minute. Before this, every such error left the session
// idle until Yousef manually said "continue"; now the hub schedules its own
// backoff nudge, exactly like the hub-restart resume path.
//
// DISTINCT from model-failure fallback (model-config.ts looksLikeModelError):
// a transient error must NOT advance the model chain or respawn anything —
// the same model works again after the wait.
// ============================================================================

/** Matches errors that resolve by waiting (retry same model, same session). */
export function isTransientApiError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('429') ||
    t.includes('rate limit') ||
    t.includes('rate_limit') ||
    t.includes('too many tokens') ||
    t.includes('too many requests') ||
    t.includes('please wait before trying again') ||
    t.includes('503') ||
    t.includes('529') ||
    t.includes('overloaded') ||
    t.includes('service unavailable') ||
    t.includes('bedrock is unable to process') ||
    t.includes('throttl') // throttled / throttling (Bedrock wording)
  )
}

/** Backoff schedule for auto-resume nudges (ms). Index = attempt number. */
export const RESUME_BACKOFF_MS = [60_000, 180_000, 420_000, 900_000] as const

export const MAX_AUTO_RESUMES_PER_HOUR = 6
