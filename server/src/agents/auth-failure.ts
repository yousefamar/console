// A session whose backend login does not work.
//
// INCIDENT 2026-10-09 02:56 → 03:39: a hub restart re-mirrored a Max-flavoured
// settings.json onto forge, which has no Max login, and all 21 forge forks
// began answering every message with "Not logged in · Please run /login". To
// the hub that was a turn like any other: the fork had replied, so it went
// idle with its instructions spent. Nothing was logged as a failure, nothing
// was raised, and it was found 35 minutes later by an agent reading a
// transcript.
//
// The CLI says exactly what happened — a synthetic assistant message carrying
// `error: "authentication_failed"` — so this is recognition, not inference.
// Two pieces: the judgement (`isAuthFailure`), and a watch that turns a fleet
// of failing sessions into ONE alert instead of twenty-one.

/** Is this synthetic message the CLI saying it has no usable login?
 *
 *  `error` is the structured field and is preferred; the text patterns are the
 *  belt for a CLI that renames it (the stream-json flag for API errors already
 *  changed case once, silently). They are deliberately narrow: each is a
 *  credential verdict, never a model or quota one. */
export function isAuthFailure(error: string | null | undefined, text: string): boolean {
  if (error === 'authentication_failed') return true
  const t = text.trim()
  // The subscription: "Not logged in · Please run /login", "Invalid API key ·
  // Please run /login", "OAuth token has expired · Please run /login".
  if (/(^|\s)Please run \/login\b/.test(t) || /^Not logged in\b/i.test(t)) return true
  // Bedrock, when the AWS identity behind it is missing or stale.
  return /could not load credentials|unable to locate credentials|security token included in the request is (expired|invalid)|\bExpiredToken(Exception)?\b/i.test(t)
}

export interface AuthFailureReport {
  sessionId: string
  name: string
  placement: 'local' | 'forge'
  /** What the session was started on, e.g. `first_party` / `bedrock`. */
  backend: string
  detail: string
  at: number
}

export interface AuthFailureAlert {
  /** Distinct sessions in this alert. */
  count: number
  forge: number
  local: number
  names: string[]
  backends: string[]
  /** The CLI's own words, from the first report. */
  detail: string
  firstAt: number
  /** Every session currently failing, including ones alerted before. */
  failingNow: number
}

/** Turns per-session reports into fleet-level alerts.
 *
 *  The first report opens a short window; when it closes, everything gathered
 *  goes out as one alert and a cooldown starts. Reports during the cooldown
 *  are held, not dropped: if any session NOT covered by the last alert failed
 *  meanwhile, a second alert goes out when the cooldown ends. A session that
 *  keeps failing is not news; a new one failing is. */
export class AuthFailureWatch {
  private pending = new Map<string, AuthFailureReport>()
  private failingNow = new Map<string, AuthFailureReport>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private cooldownUntil = 0
  private readonly windowMs: number
  private readonly cooldownMs: number

  constructor(private opts: { onAlert: (a: AuthFailureAlert) => void; windowMs?: number; cooldownMs?: number }) {
    this.windowMs = opts.windowMs ?? 20_000
    this.cooldownMs = opts.cooldownMs ?? 10 * 60_000
  }

  /** A session's turn came back as an auth failure. */
  report(r: AuthFailureReport): void {
    const isNew = !this.failingNow.has(r.sessionId)
    this.failingNow.set(r.sessionId, this.failingNow.get(r.sessionId) ?? r)
    // Already alerted and still failing: nothing new to say.
    if (!isNew && !this.pending.has(r.sessionId)) return
    if (!this.pending.has(r.sessionId)) this.pending.set(r.sessionId, r)
    this.arm()
  }

  /** The session produced a real answer again (or ended). */
  recovered(sessionId: string): void {
    this.failingNow.delete(sessionId)
    this.pending.delete(sessionId)
  }

  /** Sessions failing right now, oldest first — the re-send list. */
  failing(): AuthFailureReport[] {
    return [...this.failingNow.values()].sort((a, b) => a.at - b.at)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    if (this.timer) return
    const wait = Math.max(this.windowMs, this.cooldownUntil - Date.now())
    this.timer = setTimeout(() => this.flush(), wait)
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    const batch = [...this.pending.values()].sort((a, b) => a.at - b.at)
    this.pending.clear()
    if (!batch.length) return
    this.cooldownUntil = Date.now() + this.cooldownMs
    this.opts.onAlert({
      count: batch.length,
      forge: batch.filter((r) => r.placement === 'forge').length,
      local: batch.filter((r) => r.placement === 'local').length,
      names: batch.map((r) => r.name),
      backends: [...new Set(batch.map((r) => r.backend))],
      detail: batch[0]!.detail,
      firstAt: batch[0]!.at,
      failingNow: this.failingNow.size,
    })
  }
}

/** The alert, in words. Says WHERE the sessions run, because that is the first
 *  thing the reader needs: forge has its own identity and can lose its login
 *  while every local session is fine, and the other way round. */
export function describeAuthAlert(a: AuthFailureAlert): { title: string; body: string } {
  const where = a.forge && a.local ? `${a.forge} on forge, ${a.local} local` : a.forge ? 'all on forge' : 'all local'
  const who = a.names.slice(0, 4).join(', ') + (a.names.length > 4 ? ` +${a.names.length - 4} more` : '')
  return {
    title: a.count === 1 ? 'An agent cannot log in' : `${a.count} agents cannot log in`,
    body: `${where}, started on ${a.backends.join(' / ')}: "${a.detail}". ${who}. Each one answered its last message with that error, so its instructions were not acted on.`,
  }
}
