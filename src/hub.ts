// Centralized hub access — single source of truth for hub URL and fetch
//
// As of the public-Funnel refactor, the hub is reached via Caddy under the
// `/hub` prefix on the same origin as the SPA. The legacy `:9877` direct path
// is kept as a one-shot fallback during the cutover: if `${origin}/hub/health`
// returns 404, we treat it as "Caddy hasn't been reloaded yet" and fall back
// to the old `:hostname:9877` form for the remainder of the page lifetime.
//
// LocalStorage override remains supported for development against another hub.

const HUB_URL_KEY = 'console_hub_url'

function originHubUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:9877'
  return `${window.location.origin}/hub`
}

function legacyHubUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:9877'
  return `${window.location.protocol}//${window.location.hostname || 'localhost'}:9877`
}

let migrated = false
function migrate() {
  if (migrated || typeof localStorage === 'undefined') return
  migrated = true
  for (const key of ['consoleServerUrl', 'console-server-url']) {
    const old = localStorage.getItem(key)
    if (old && !localStorage.getItem(HUB_URL_KEY)) {
      localStorage.setItem(HUB_URL_KEY, old)
    }
  }
}

// Cutover fallback: if a /hub/* probe 404s we flip to the legacy direct path
// for the rest of the page lifetime. Survives a page reload via sessionStorage
// so the SPA doesn't probe every navigation.
let legacyMode: boolean | null = null

function readLegacyMode(): boolean {
  if (legacyMode !== null) return legacyMode
  try {
    legacyMode = sessionStorage.getItem('console_hub_legacy') === '1'
  } catch { legacyMode = false }
  return legacyMode
}

export function markHubLegacy(): void {
  legacyMode = true
  try { sessionStorage.setItem('console_hub_legacy', '1') } catch { /* no-op */ }
}

export function getHubUrl(): string {
  if (typeof localStorage !== 'undefined') {
    migrate()
    const override = localStorage.getItem(HUB_URL_KEY)
    if (override) return override
  }
  return readLegacyMode() ? legacyHubUrl() : originHubUrl()
}

export function setHubUrl(url: string): void {
  localStorage.setItem(HUB_URL_KEY, url)
}

export function getHubWsUrl(): string {
  return getHubUrl().replace(/^http/, 'ws')
}

// authPending is a process-wide flag the LoginScreen listens to. We set it
// when a hub request returns 401 with `WWW-Authenticate: ConsoleSession`,
// i.e. enforcement has been flipped on and we don't have a valid session.
type AuthListener = (pending: boolean) => void
const authListeners = new Set<AuthListener>()
let authPending = false

export function isAuthPending(): boolean { return authPending }

export function subscribeAuthPending(fn: AuthListener): () => void {
  authListeners.add(fn)
  return () => authListeners.delete(fn)
}

function setAuthPending(value: boolean): void {
  if (authPending === value) return
  authPending = value
  for (const fn of authListeners) {
    try { fn(value) } catch { /* listener bugs must not break hub calls */ }
  }
}

export interface HubFetchOptions extends RequestInit {
  /** Abort the request after this many ms. Undefined = no timeout. */
  timeoutMs?: number
}

/**
 * Merge a caller-provided AbortSignal with a timeout AbortSignal so whichever
 * fires first aborts the fetch.
 */
function withTimeout(opts?: HubFetchOptions): { signal?: AbortSignal; cleanup: () => void } {
  if (!opts?.timeoutMs) return { signal: opts?.signal ?? undefined, cleanup: () => {} }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('hubFetch timeout', 'TimeoutError')), opts.timeoutMs)
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason)
    else opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal!.reason), { once: true })
  }
  return { signal: ctrl.signal, cleanup: () => clearTimeout(timer) }
}

/**
 * Inspect a response: if the hub asked for a ConsoleSession via
 * `WWW-Authenticate`, flip the global authPending flag so the LoginScreen
 * mounts. We intentionally only react to that exact challenge — generic 401s
 * from individual handlers don't pop the login dialog.
 */
function noteAuthChallenge(res: Response): void {
  if (res.status !== 401) return
  const www = res.headers.get('WWW-Authenticate') || ''
  if (www.includes('ConsoleSession')) setAuthPending(true)
}

/**
 * First-request cutover guard: if we're hitting the `${origin}/hub` path and
 * Caddy hasn't been reloaded yet, that URL maps to the Vite catch-all and
 * returns an HTML 200. Detect that (Content-Type starts with text/html for a
 * request we expected JSON for) and switch to legacy `:9877` for the rest of
 * the page lifetime. One-shot — we only retry once.
 */
async function fetchHubFirst(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (readLegacyMode()) return res
  // Hub HTML 404 page is < 2KB; the Vite shell is much larger and identifies
  // itself with the Vite refresh script. The cheap check is Content-Type:
  // a real /hub response is application/json (or octet-stream for binary),
  // never text/html.
  const ct = res.headers.get('content-type') || ''
  if (res.status === 200 && ct.startsWith('text/html')) {
    markHubLegacy()
  }
  return res
}

/**
 * Whether we should send cookies / receive Set-Cookie on this hub URL. Only
 * when same-origin with the SPA (i.e. via Caddy `/hub`). Cross-origin legacy
 * fetches to `:9877` keep their pre-refactor unauthenticated semantics so the
 * tailnet path keeps working during the cutover, before Caddy is reloaded.
 */
function shouldUseCredentials(url: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const u = new URL(url, window.location.origin)
    return u.origin === window.location.origin
  } catch { return false }
}

export async function hubFetch<T>(path: string, opts?: HubFetchOptions): Promise<T> {
  const { signal, cleanup } = withTimeout(opts)
  try {
    const url = `${getHubUrl()}${path}`
    const baseInit: RequestInit = {
      ...opts,
      signal,
      ...(shouldUseCredentials(url) ? { credentials: 'include' } : {}),
      headers: {
        'Content-Type': 'application/json',
        ...opts?.headers,
      },
    }
    const res = await fetchHubFirst(url, baseInit)
    noteAuthChallenge(res)
    if (!res.ok) {
      const text = await res.text()
      throw new HubError(res.status, text)
    }
    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  } finally {
    cleanup()
  }
}

/** Raw fetch that returns Response (for stores that need it, e.g. bookmarks/feeds) */
export function hubFetchRaw(path: string, opts?: HubFetchOptions): Promise<Response> {
  const { signal, cleanup } = withTimeout(opts)
  const url = `${getHubUrl()}${path}`
  const init: RequestInit = { ...opts, signal, ...(shouldUseCredentials(url) ? { credentials: 'include' } : {}) }
  const promise = fetchHubFirst(url, init).then((res) => {
    noteAuthChallenge(res)
    return res
  })
  promise.finally(cleanup)
  return promise
}

export class HubError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HubError'
  }
}
