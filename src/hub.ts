// Centralized hub access — single source of truth for hub URL and fetch

const HUB_URL_KEY = 'console_hub_url'
const DEFAULT_HUB_URL = typeof window !== 'undefined'
  ? `${window.location.protocol}//${window.location.hostname || 'localhost'}:9877`
  : 'http://localhost:9877'

// Migrate legacy keys on first access
let migrated = false
function migrate() {
  if (migrated || typeof localStorage === 'undefined') return
  migrated = true
  // Legacy keys from various stores
  for (const key of ['consoleServerUrl', 'console-server-url']) {
    const old = localStorage.getItem(key)
    if (old && !localStorage.getItem(HUB_URL_KEY)) {
      localStorage.setItem(HUB_URL_KEY, old)
    }
  }
}

export function getHubUrl(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_HUB_URL
  migrate()
  return localStorage.getItem(HUB_URL_KEY) || DEFAULT_HUB_URL
}

export function setHubUrl(url: string): void {
  localStorage.setItem(HUB_URL_KEY, url)
}

export function getHubWsUrl(): string {
  return getHubUrl().replace(/^http/, 'ws')
}

export async function hubFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${getHubUrl()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new HubError(res.status, text)
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

/** Raw fetch that returns Response (for stores that need it, e.g. bookmarks/feeds) */
export function hubFetchRaw(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${getHubUrl()}${path}`, opts)
}

export class HubError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HubError'
  }
}
