// HTTP client for Console Hub
// All CLI commands go through this to talk to the hub server.

const DEFAULT_HUB_URL = 'http://localhost:9877'

export function getHubUrl(): string {
  return process.env.CONSOLE_HUB_URL || DEFAULT_HUB_URL
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
  const base = opts.hubUrl || getHubUrl()
  const url = new URL(path, base)

  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined) url.searchParams.set(k, v)
    }
  }

  const headers: Record<string, string> = {}
  let body: string | undefined
  if (opts.body) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const controller = new AbortController()
  const timer = opts.timeout
    ? setTimeout(() => controller.abort(), opts.timeout)
    : undefined

  let res: Response
  try {
    res = await fetch(url.toString(), {
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
