// HTTP client for Console Hub
// All CLI commands go through this to talk to the hub server.
//
// The hub serves HTTPS when Tailscale certs are present (the normal setup;
// see `server/src/index.ts` — `tlsOpts`), and falls back to plain HTTP when
// they aren't. The CLI auto-detects the scheme by probing HTTPS first and
// only falling back to HTTP on a connection-level failure, with the result
// cached for subsequent calls in the same process.
//
// The hub's internal TLS cert (if any) is self-signed and bound to a
// hostname that isn't `localhost`, so we pass a dedicated undici dispatcher
// with `rejectUnauthorized: false` on every HTTPS request. Scoped rather
// than global (which would emit a loud Node warning) and restricted to the
// CLI, which only talks to the local hub.

import { Agent } from 'undici'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const DEFAULT_HUB_PORT = 9877
const DEFAULT_HUB_HOST = 'localhost'

const LOCAL_TOKENS_FILE = join(homedir(), '.config', 'console', 'local-tokens.json')

let cachedHubToken: string | null | undefined

/**
 * Read the CLI-scoped bearer token from `~/.config/console/local-tokens.json`.
 * Cached for process lifetime. CONSOLE_HUB_TOKEN env var overrides for use
 * from off-host shells. Returns null if no token is available — we attach
 * the header opportunistically while enforcement is off.
 */
export function getHubToken(): string | null {
  if (cachedHubToken !== undefined) return cachedHubToken
  if (process.env.CONSOLE_HUB_TOKEN) {
    cachedHubToken = process.env.CONSOLE_HUB_TOKEN
    return cachedHubToken
  }
  try {
    if (existsSync(LOCAL_TOKENS_FILE)) {
      const parsed = JSON.parse(readFileSync(LOCAL_TOKENS_FILE, 'utf8')) as { cli?: string }
      cachedHubToken = parsed.cli ?? null
      return cachedHubToken
    }
  } catch {
    // unreadable / corrupt — proceed without
  }
  cachedHubToken = null
  return null
}

/** Fetch that ignores self-signed certs but only for HTTPS URLs. */
function insecureFetch(url: string, init?: RequestInit): Promise<Response> {
  const isHttps = url.startsWith('https:')
  const extra = isHttps ? { dispatcher: insecureDispatcher } : {}
  // `dispatcher` is an undici extension, not in the lib.dom RequestInit type.
  return fetch(url, { ...init, ...extra } as RequestInit)
}

let cachedHubUrl: string | null = null

export function getHubUrl(): string {
  if (process.env.CONSOLE_HUB_URL) return process.env.CONSOLE_HUB_URL
  return cachedHubUrl ?? `https://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`
}

/**
 * Does a hub answer at `baseUrl`? Only the STATUS is wanted, so the body is
 * cancelled, and that is the whole point of this function.
 *
 * `/health` carries the full session list. Left unread, a body larger than the
 * ~64 KiB the HTTP client will buffer is never fully received: the connection
 * stays open and holds this process alive until the hub drops it, about 65 s
 * later. The command had long since printed its answer; it just could not EXIT.
 * On 9 Oct 2026 the fleet reached 78 sessions, `/health` crossed 64 KiB at about
 * 04:30, and from then every `con` call took 17-74 s to return. Guards that
 * shell out to `con` under a 60 s cap timed out, and the hub logged each
 * timeout as "guard: no change" — four hours of blind watchers.
 *
 * Exported for the test that pins this.
 */
export async function probeHub(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await insecureFetch(`${baseUrl}/health`, { signal: ctrl.signal })
    await res.body?.cancel().catch(() => {})
    return res.ok
  } catch {
    return false
  } finally {
    // A pending timer keeps the process alive too, if only for 1.5 s.
    clearTimeout(t)
  }
}

/**
 * Probe HTTPS then HTTP on the default host/port. Caches the winning URL for
 * the lifetime of the process. Only runs if `CONSOLE_HUB_URL` isn't set.
 */
async function detectHubUrl(): Promise<string> {
  if (process.env.CONSOLE_HUB_URL) return process.env.CONSOLE_HUB_URL
  if (cachedHubUrl) return cachedHubUrl
  for (const proto of ['https', 'http'] as const) {
    const url = `${proto}://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`
    if (await probeHub(url)) {
      cachedHubUrl = url
      return url
    }
  }
  // Default to HTTPS if both probes fail — the error will surface cleanly
  // through the usual HubUnavailableError path.
  return `https://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`
}

export class HubError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HubError'
  }
}

export class HubUnavailableError extends Error {
  constructor() {
    super('Hub not running. Start with: cd server && npm run dev')
    this.name = 'HubUnavailableError'
  }
}

export async function hubFetch<T = unknown>(
  path: string,
  opts: {
    method?: string
    body?: unknown
    params?: Record<string, string | undefined>
    hubUrl?: string
    timeout?: number
    raw?: boolean // return raw response instead of JSON
  } = {},
): Promise<T> {
  const base = opts.hubUrl || await detectHubUrl()
  const url = new URL(path, base)

  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined) url.searchParams.set(k, v)
    }
  }

  const headers: Record<string, string> = {}
  // Agent self-identification (set by the hub at session spawn) — lets the
  // hub attribute board mutations to the acting agent.
  if (process.env.CONSOLE_AGENT_KEY) headers['X-Console-Agent'] = process.env.CONSOLE_AGENT_KEY
  let body: string | undefined
  if (opts.body) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const token = getHubToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const controller = new AbortController()
  const timer = opts.timeout
    ? setTimeout(() => controller.abort(), opts.timeout)
    : undefined

  let res: Response
  try {
    res = await insecureFetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HubError(0, 'TIMEOUT', 'Request timed out')
    }
    throw new HubUnavailableError()
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (opts.raw) return res as unknown as T

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let code = 'ERROR'
    if (res.status === 401) code = 'AUTH_REQUIRED'
    else if (res.status === 404) code = 'NOT_FOUND'
    else if (res.status === 429) code = 'RATE_LIMITED'
    throw new HubError(res.status, code, text || `HTTP ${res.status}`)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

export async function hubHealth(): Promise<{ ok: boolean; version: string; sessions: unknown[]; cwd: string }> {
  return hubFetch('/health')
}
