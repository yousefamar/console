import { db } from '@/db'
import { getMeta, setMeta } from '@/db'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/contacts.other.readonly https://www.googleapis.com/auth/contacts.readonly'
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest'

const TOKEN_KEY = 'console_access_token'
const EXPIRY_KEY = 'console_token_expiry'

let accessToken: string | null = localStorage.getItem(TOKEN_KEY)
let tokenExpiry: number = parseInt(localStorage.getItem(EXPIRY_KEY) ?? '0')
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function persistToken(token: string, expiresIn: number) {
  accessToken = token
  tokenExpiry = Date.now() + expiresIn * 1000
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(EXPIRY_KEY, String(tokenExpiry))
  scheduleTokenRefresh(expiresIn)
}

// Proactively refresh the token 5 minutes before it expires.
// This calls the backend /api/auth/refresh endpoint — no popups.
function scheduleTokenRefresh(expiresIn: number) {
  if (refreshTimer) clearTimeout(refreshTimer)
  const refreshInMs = Math.max((expiresIn - 300) * 1000, 0)
  refreshTimer = setTimeout(async () => {
    const success = await refreshAccessToken()
    if (!success) {
      notifyAuthExpired()
    }
  }, refreshInMs)
}

function clearToken() {
  accessToken = null
  tokenExpiry = 0
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXPIRY_KEY)
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

// Auth expiry listener — fires when refresh token is dead and user must re-auth
type AuthExpiredListener = () => void
let authExpiredListeners: AuthExpiredListener[] = []

export function onAuthExpired(fn: AuthExpiredListener): () => void {
  authExpiredListeners.push(fn)
  return () => { authExpiredListeners = authExpiredListeners.filter((l) => l !== fn) }
}

export function notifyAuthExpired() {
  clearToken()
  for (const fn of authExpiredListeners) fn()
}

// Load the Google Identity Services script
function loadGisScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById('gis-script')) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.id = 'gis-script'
    script.src = 'https://accounts.google.com/gsi/client'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(script)
  })
}

// Load the Google API client library
function loadGapiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById('gapi-script')) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.id = 'gapi-script'
    script.src = 'https://apis.google.com/js/api.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google API client'))
    document.head.appendChild(script)
  })
}

async function initGapi(): Promise<void> {
  await new Promise<void>((resolve) => gapi.load('client', resolve))
  await gapi.client.init({})
  await gapi.client.load(DISCOVERY_DOC)
}

export async function initAuth(): Promise<void> {
  await Promise.all([loadGisScript(), loadGapiScript()])
  await initGapi()

  if (accessToken && tokenExpiry > Date.now()) {
    // Valid token — schedule proactive refresh
    const remainingSecs = Math.floor((tokenExpiry - Date.now()) / 1000)
    scheduleTokenRefresh(remainingSecs)
  } else {
    // Token expired or missing — try refreshing with stored refresh token
    const refreshed = await refreshAccessToken()
    if (!refreshed) {
      clearToken()
    }
  }
}

// Sign in via authorization code flow (popup mode).
// The popup gets a code, which we exchange for tokens via the backend.
export function signIn(): Promise<string> {
  return new Promise((resolve, reject) => {
    const codeClient = google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      ux_mode: 'popup',
      callback: async (response) => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }
        try {
          const res = await fetch('/api/auth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: response.code }),
          })
          if (!res.ok) {
            const text = await res.text()
            reject(new Error(`Token exchange failed: ${text}`))
            return
          }
          const data = await res.json() as {
            access_token: string
            expires_in: number
            refresh_token?: string
          }
          persistToken(data.access_token, data.expires_in)
          if (data.refresh_token) {
            await setMeta('refresh_token', data.refresh_token)
          }
          resolve(data.access_token)
        } catch (err) {
          reject(err)
        }
      },
    })
    codeClient.requestCode()
  })
}

// Refresh the access token using the stored refresh token via the backend.
// Returns true if successful. No user interaction needed.
let refreshPromise: Promise<boolean> | null = null

export async function refreshAccessToken(): Promise<boolean> {
  // Deduplicate concurrent refresh calls
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefresh().finally(() => { refreshPromise = null })
  return refreshPromise
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = await getMeta('refresh_token')
  if (!refreshToken) return false

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!res.ok) {
      if (res.status === 401) {
        // Refresh token revoked — clear everything
        await db.meta.delete('refresh_token')
      }
      return false
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    persistToken(data.access_token, data.expires_in)
    return true
  } catch {
    return false // Network error — will retry later
  }
}

export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken
  }
  // Token expired — try silent refresh via backend
  const refreshed = await refreshAccessToken()
  if (refreshed) return accessToken
  return null
}

export function isSignedIn(): boolean {
  return !!accessToken && Date.now() < tokenExpiry
}

export async function signOut(): Promise<void> {
  // Revoke the refresh token at Google (best effort)
  const refreshToken = await getMeta('refresh_token')
  if (refreshToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {})
  }
  clearToken()
  await db.meta.delete('refresh_token')
}

// Type declarations for Google Identity Services
declare global {
  // eslint-disable-next-line no-var
  var google: {
    accounts: {
      oauth2: {
        initCodeClient(config: {
          client_id: string
          scope: string
          ux_mode: 'popup' | 'redirect'
          callback: (response: { code: string; error?: string }) => void
        }): { requestCode(): void }
        revoke(token: string, callback: () => void): void
      }
    }
  }
  // eslint-disable-next-line no-var
  var gapi: {
    load(api: string, callback: () => void): void
    client: {
      init(config: object): Promise<void>
      load(discoveryDoc: string): Promise<void>
      getToken(): { access_token: string } | null
      setToken(token: { access_token: string } | null): void
      request(args: {
        path: string
        method?: string
        params?: Record<string, string>
        body?: unknown
        headers?: Record<string, string>
      }): Promise<{ result: unknown; body: string; status: number }>
    }
  }
}
