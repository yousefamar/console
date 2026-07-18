// Hub auth middleware — gates HTTP + WebSocket requests.
//
// Phases of rollout (see /home/amar/.claude/plans/idempotent-dreaming-parasol.md):
//   * Built log-only by default. Enforcement is OFF unless CONSOLE_AUTH_ENABLED=1.
//   * Break-glass: CONSOLE_AUTH_DISABLED=1 forces allow regardless of CONSOLE_AUTH_ENABLED.
//   * Caddy strips /hub prefix before requests reach the hub. The middleware
//     itself does not care about the prefix — it operates on whatever URL the
//     hub sees post-strip.

import type { IncomingMessage } from 'node:http'
import type { AuthStore, HubSession, HubToken } from './auth-store.js'

const SESSION_COOKIE = 'console_session'

export type Principal =
  | { kind: 'session'; sessionId: string; email: string; session: HubSession }
  | { kind: 'bearer'; tokenId: string; scope: HubToken['scope']; token: HubToken }
  | { kind: 'loopback' }

export interface AuthDecision {
  allow: boolean
  principal?: Principal
  reason?: string
  challenge?: boolean // hint to caller to set WWW-Authenticate
}

function envFlag(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v === 'true' || v === 'yes'
}

export function authEnforcementActive(): boolean {
  if (envFlag('CONSOLE_AUTH_DISABLED')) return false
  return envFlag('CONSOLE_AUTH_ENABLED')
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function parseBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

/**
 * `/public/*` is the un-authenticated surface (canvas tokens, cron.ics, apk).
 * Caddy preserves the prefix for these (handle, not handle_path), so the hub
 * sees `/public/...` here.
 */
export function isPublicPath(path: string): boolean {
  return path.startsWith('/public/') || path === '/public'
}

/**
 * Some routes are intentionally open in every mode (health, OAuth start/callback,
 * Monzo webhook). Add them here only if they have their own out-of-band auth
 * (e.g. Monzo signature, OAuth state token) or are required to function before
 * any client has credentials.
 */
export function isAlwaysOpenPath(path: string, method: string): boolean {
  if (path === '/health') return true
  if (path.startsWith('/auth/google/start')) return true
  if (path.startsWith('/auth/google/callback')) return true
  if (path.startsWith('/auth/google/poll')) return true
  if (path.startsWith('/auth/claim')) return true
  if (path.startsWith('/auth/monzo/start')) return true
  if (path.startsWith('/auth/monzo/callback')) return true
  if (path.startsWith('/auth/monzo/poll')) return true
  if (path === '/auth/session' && method === 'GET') return true
  if (path === '/money/webhook') return true
  // Voice webhooks are hit by Atoms from the public internet via
  // al.amar.io → Caddy → hub. They authenticate via their own signed payloads
  // and the route handler's payload checks; the hub bearer doesn't apply.
  if (path === '/voice/delegate' || path.startsWith('/voice/delegate?')) return true
  if (path === '/voice/webhook') return true
  if (path === '/voice/health') return true
  if (path === '/canvas/index.html' || path === '/canvas' || path.startsWith('/canvas/')) {
    // Canvas iframe is loaded by the SPA inside a sandboxed frame; access is
    // already gated by the SPA's own session. v1 keeps it open so the iframe
    // can render before we've sorted same-origin embedding under /hub.
    return true
  }
  return false
}

/**
 * True only for requests that reached the hub directly via loopback, NOT for
 * Caddy-proxied requests that happen to come from 127.0.0.1 at the TCP layer.
 * Caddy always sets X-Forwarded-For; its presence proves the original client
 * was off-host. Without this check, Caddy traffic would silently bypass auth
 * enforcement.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  const isLocalSocket = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!isLocalSocket) return false
  if (req.headers['x-forwarded-for']) return false
  if (req.headers['x-forwarded-host']) return false
  if (req.headers['x-forwarded-proto']) return false
  return true
}

/**
 * Compute the auth decision for a request. In log-only mode the caller is
 * expected to honour {allow:true} regardless of {reason} — but emit a debug
 * line so we can verify the decision the enforcing mode would have made.
 */
export function decide(req: IncomingMessage, store: AuthStore): AuthDecision {
  const url = req.url ?? '/'
  const path = url.split('?')[0]
  const method = req.method ?? 'GET'

  if (isPublicPath(path)) {
    return { allow: true, reason: 'public-namespace' }
  }
  if (isAlwaysOpenPath(path, method)) {
    return { allow: true, reason: 'always-open' }
  }

  const cookies = parseCookies(req)
  const sessionId = cookies[SESSION_COOKIE]
  const bearer = parseBearer(req)

  if (sessionId && bearer) {
    // Confused-deputy guard: a request must pick ONE auth path.
    return { allow: false, reason: 'cookie-and-bearer', challenge: true }
  }

  if (sessionId) {
    const session = store.findHubSession(sessionId)
    if (session) {
      return {
        allow: true,
        reason: 'session',
        principal: { kind: 'session', sessionId, email: session.email, session },
      }
    }
    return { allow: false, reason: 'session-not-found', challenge: true }
  }

  if (bearer) {
    const token = store.validateHubToken(bearer)
    if (token) {
      return {
        allow: true,
        reason: 'bearer',
        principal: { kind: 'bearer', tokenId: token.id, scope: token.scope, token },
      }
    }
    return { allow: false, reason: 'bearer-invalid', challenge: true }
  }

  // Loopback fallback: in log-only mode, same-host clients (CLI, Al, agents)
  // historically connect with no credentials. Once enforcement is on they MUST
  // present a bearer; in the meantime label them so the logs are useful.
  if (isLoopback(req)) {
    return { allow: true, reason: 'loopback-unauthenticated', principal: { kind: 'loopback' } }
  }

  return { allow: false, reason: 'no-credentials', challenge: true }
}

/**
 * Apply the decision. In log-only mode, force allow but log what enforcement
 * would have done. The caller (HTTP handler / WS verifyClient) then proceeds
 * (or rejects on `enforced && !allow`).
 */
export function enforce(req: IncomingMessage, store: AuthStore): AuthDecision {
  const decision = decide(req, store)
  const enforcing = authEnforcementActive()
  if (!enforcing) {
    if (!decision.allow) {
      const ua = req.headers['user-agent'] ?? '-'
      const path = (req.url ?? '/').split('?')[0]
      console.log(`[auth] would-reject ${req.method} ${path} reason=${decision.reason} ua=${ua}`)
    }
    return { ...decision, allow: true, reason: decision.reason ?? 'log-only' }
  }
  return decision
}

/**
 * WebSocket upgrade gate — the WS analogue of `enforce()`. Browsers must pass
 * the Origin allow-list AND carry a valid session cookie; non-browser clients
 * (no Origin header) must present a bearer or arrive via true loopback.
 *
 * `/stt` is temporarily exempt: the v38 APK's PTT path opens it without a
 * bearer, so enforcing here would break phone push-to-talk. The native app
 * (M1) attaches the bearer on /stt — remove the exemption once it ships.
 */
export function decideWsUpgrade(
  req: IncomingMessage,
  store: AuthStore,
  isOriginAllowed: (origin: string | undefined) => boolean,
): AuthDecision {
  const origin = req.headers.origin as string | undefined
  if (origin && !isOriginAllowed(origin)) {
    return { allow: false, reason: 'ws-origin-not-allowed' }
  }
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/stt') {
    return { allow: true, reason: 'ws-stt-exempt-v38-apk' }
  }
  return enforce(req, store)
}

/**
 * CSRF defence-in-depth for cookie-authenticated mutating requests. Bearer
 * requests bypass this (they're not subject to ambient browser-side risk).
 */
export function isCsrfSafe(req: IncomingMessage, decision: AuthDecision, publicOrigin: string): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  if (!decision.principal || decision.principal.kind !== 'session') return true
  const origin = req.headers.origin
  const referer = req.headers.referer
  const expected = publicOrigin
  if (origin && origin === expected) return true
  if (!origin && referer && referer.startsWith(expected + '/')) return true
  return false
}

/**
 * Build a Set-Cookie value for a freshly-minted session.
 * Path=/hub so the cookie never leaks into /public/* or the SPA static path.
 */
export function buildSessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/hub',
    `Max-Age=${30 * 24 * 60 * 60}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/hub',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE
