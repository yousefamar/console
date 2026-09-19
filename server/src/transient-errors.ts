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
//
// EXCEPT when it doesn't: 2026-09-17 one Bedrock model (fable-5-1) went 503 on
// every route for hours while its siblings stayed up. Each 503 is transient
// in isolation, so every session sat in backoff-nudge purgatory and the chain
// never advanced — the fleet hung until a human ran `con agent model set`.
// `UpstreamOutageTracker` below counts those failures fleet-wide PER MODEL
// and, once they look like an outage rather than a blip, lets the session
// signal `model_failure` so the ordinary chain-advance path takes over.
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
    // "API Error: Server error mid-response. The response above may be
    // incomplete." — seen live 2026-08-15, halted a session.
    t.includes('server error') ||
    t.includes('server-side issue') ||
    t.includes('internal server error') ||
    t.includes('500') ||
    t.includes('502') ||
    t.includes('bad gateway') ||
    t.includes('connectionrefused') ||
    t.includes('unable to connect') ||
    t.includes('bedrock is unable to process') ||
    t.includes('throttl') || // throttled / throttling (Bedrock wording)
    // Network-flavour transients: same policy — the turn died, the session is
    // fine, retry after a wait. Seen live: "API Error: The operation timed
    // out." sat unresumed because none of the HTTP-status patterns matched.
    t.includes('timed out') ||
    t.includes('timeout') ||
    t.includes('econnreset') ||
    t.includes('econnrefused') ||
    t.includes('socket hang up') ||
    t.includes('fetch failed') ||
    t.includes('network error')
  )
}

/** Backoff schedule for auto-resume nudges (ms). Index = attempt number. */
export const RESUME_BACKOFF_MS = [60_000, 180_000, 420_000, 900_000] as const

export const MAX_AUTO_RESUMES_PER_HOUR = 6

/** The subset of transient errors that can mean "this MODEL's upstream is
 *  down" (Bedrock ServiceUnavailable / first-party overloaded). Rate limits are
 *  our own quota, timeouts and socket errors are the network — a run of those
 *  says nothing about the model, so they never feed the outage tracker. */
export function isUpstreamOutageError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('503') ||
    t.includes('529') ||
    t.includes('overloaded') ||
    t.includes('service unavailable') ||
    t.includes('serviceunavailable') ||
    t.includes('bedrock is unable to process')
  )
}

/** Outage = at least this many upstream failures on one model ... */
export const OUTAGE_MIN_FAILURES = 3
/** ... spread over at least this long (a simultaneous burst from ten sessions
 *  is one blip, not an outage; the auto-resume backoff — 60 s, then 180 s —
 *  means the third wave lands at ~4 min, and so does a lone session's third
 *  retry) ... */
export const OUTAGE_MIN_SPAN_MS = 120_000
/** ... within this window, outnumbering successes on that model 2:1. */
export const OUTAGE_WINDOW_MS = 600_000
/** Never auto-advance twice within this long: if the model we just moved to is
 *  failing too, the problem isn't the model — hold there (auto-resume keeps
 *  nudging) instead of cascading down the chain to haiku in 20 minutes. */
export const OUTAGE_ADVANCE_COOLDOWN_MS = 600_000

export class UpstreamOutageTracker {
  private failures = new Map<string, number[]>()
  private successes = new Map<string, number[]>()
  private lastAdvanceAt = -Infinity

  constructor(private now: () => number = () => Date.now()) {}

  /** A turn on `model` completed. */
  recordSuccess(model: string): void {
    if (!model) return
    this.push(this.successes, model, this.now())
  }

  /** An upstream-outage-class error hit `model`. Returns a reason string when
   *  the streak now looks like an outage (caller advances the chain), else null.
   *  Firing resets the model's streak; a hold (cooldown) keeps it. */
  recordFailure(model: string): string | null {
    if (!model) return null
    const now = this.now()
    const fails = this.push(this.failures, model, now)
    if (fails.length < OUTAGE_MIN_FAILURES) return null
    const oldest = fails[0]!
    const span = now - oldest
    if (span < OUTAGE_MIN_SPAN_MS) return null
    const okSince = this.prune(this.successes, model, now).filter((t) => t >= oldest).length
    if (fails.length <= okSince * 2) return null
    if (now - this.lastAdvanceAt < OUTAGE_ADVANCE_COOLDOWN_MS) return null
    this.lastAdvanceAt = now
    this.failures.delete(model)
    this.successes.delete(model)
    return `${fails.length} upstream failures over ${(span / 60_000).toFixed(1)} min vs ${okSince} successes`
  }

  private push(map: Map<string, number[]>, model: string, now: number): number[] {
    const list = this.prune(map, model, now)
    list.push(now)
    return list
  }

  private prune(map: Map<string, number[]>, model: string, now: number): number[] {
    const cutoff = now - OUTAGE_WINDOW_MS
    const list = (map.get(model) ?? []).filter((t) => t > cutoff)
    map.set(model, list)
    return list
  }
}

/** Process-wide instance — one fleet, one view of each model's health. */
export const upstreamOutages = new UpstreamOutageTracker()
