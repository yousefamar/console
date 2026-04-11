import { getHubUrl } from '@/hub'

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

// Auth expiry listener — fires when hub can't provide a token
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

/** Fetch a fresh access token from the hub server */
export async function refreshAccessToken(): Promise<boolean> {
  try {
    const res = await fetch(`${getHubUrl()}/auth/token`)
    if (!res.ok) return false
    const data = await res.json() as { access_token: string; expires_in: number; email: string }
    persistToken(data.access_token, data.expires_in)
    return true
  } catch {
    return false
  }
}

export async function initAuth(): Promise<void> {
  if (accessToken && tokenExpiry > Date.now()) {
    // Valid token — schedule proactive refresh
    const remainingSecs = Math.floor((tokenExpiry - Date.now()) / 1000)
    scheduleTokenRefresh(remainingSecs)
  } else {
    // Token expired or missing — fetch from hub
    const refreshed = await refreshAccessToken()
    if (!refreshed) {
      clearToken()
    }
  }
}

/**
 * Sign in via hub's Google OAuth flow.
 * Opens the hub's /auth/google/start in a popup, polls /auth/google/poll for completion.
 */
export function signIn(popup?: Window | null): Promise<string> {
  // Popup must be opened by the caller in the click handler to preserve user gesture.
  // If not provided, try opening here (may be blocked).
  if (popup === undefined) {
    popup = window.open(
      `${getHubUrl()}/auth/google/start`,
      'google-auth',
      'width=500,height=600,menubar=no,toolbar=no',
    )
  }
  return new Promise((resolve, reject) => {
    const hubUrl = getHubUrl()

    if (!popup) {
      reject(new Error('Popup blocked'))
      return
    }

    const interval = setInterval(async () => {
      // Check if popup was closed by user
      if (popup.closed) {
        clearInterval(interval)
        reject(new Error('Sign-in cancelled'))
        return
      }

      try {
        const res = await fetch(`${hubUrl}/auth/google/poll`)
        if (!res.ok) return
        const data = await res.json() as { done: boolean; email?: string }
        if (data.done && data.email) {
          clearInterval(interval)
          popup.close()
          // Fetch token from hub
          const refreshed = await refreshAccessToken()
          if (refreshed) {
            resolve(data.email)
          } else {
            reject(new Error('Token fetch failed after sign-in'))
          }
        }
      } catch {
        // Network error — keep polling
      }
    }, 1000)

    // Timeout after 5 minutes
    setTimeout(() => {
      clearInterval(interval)
      if (!popup.closed) popup.close()
      reject(new Error('Sign-in timed out'))
    }, 5 * 60 * 1000)
  })
}

export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken
  }
  const refreshed = await refreshAccessToken()
  if (refreshed) return accessToken
  return null
}

export function isSignedIn(): boolean {
  return !!accessToken && Date.now() < tokenExpiry
}

export async function signOut(): Promise<void> {
  clearToken()
}
