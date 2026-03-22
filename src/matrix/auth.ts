import { db, setMeta } from '@/db'

const MATRIX_TOKEN_KEY = 'matrix_access_token'
const MATRIX_USER_KEY = 'matrix_user_id'
const MATRIX_DEVICE_KEY = 'matrix_device_id'
const MATRIX_HS_KEY = 'matrix_homeserver'

let accessToken: string | null = localStorage.getItem(MATRIX_TOKEN_KEY)
let userId: string | null = localStorage.getItem(MATRIX_USER_KEY)
let deviceId: string | null = localStorage.getItem(MATRIX_DEVICE_KEY)
let homeserver: string | null = localStorage.getItem(MATRIX_HS_KEY)

// Auth state listener — fires when Matrix session changes
type MatrixAuthListener = (connected: boolean) => void
let authListeners: MatrixAuthListener[] = []

export function onMatrixAuthChange(fn: MatrixAuthListener): () => void {
  authListeners.push(fn)
  fn(isMatrixConnected())
  return () => { authListeners = authListeners.filter((l) => l !== fn) }
}

function notifyAuthChange() {
  const connected = isMatrixConnected()
  for (const fn of authListeners) fn(connected)
}

function persistSession(token: string, user: string, device: string, hs: string) {
  accessToken = token
  userId = user
  deviceId = device
  homeserver = hs
  localStorage.setItem(MATRIX_TOKEN_KEY, token)
  localStorage.setItem(MATRIX_USER_KEY, user)
  localStorage.setItem(MATRIX_DEVICE_KEY, device)
  localStorage.setItem(MATRIX_HS_KEY, hs)
  notifyAuthChange()
}

function clearSession() {
  accessToken = null
  userId = null
  deviceId = null
  homeserver = null
  localStorage.removeItem(MATRIX_TOKEN_KEY)
  localStorage.removeItem(MATRIX_USER_KEY)
  localStorage.removeItem(MATRIX_DEVICE_KEY)
  localStorage.removeItem(MATRIX_HS_KEY)
  notifyAuthChange()
}

// Resolve homeserver URL from a user-provided server name
// Tries .well-known discovery, falls back to https://server
export async function resolveHomeserver(server: string): Promise<string> {
  // If already a full URL, use as-is
  if (server.startsWith('http://') || server.startsWith('https://')) {
    return server.replace(/\/+$/, '')
  }

  // Try .well-known discovery
  try {
    const res = await fetch(`https://${server}/.well-known/matrix/client`)
    if (res.ok) {
      const data = await res.json()
      const baseUrl = data?.['m.homeserver']?.base_url
      if (baseUrl) return baseUrl.replace(/\/+$/, '')
    }
  } catch {
    // Discovery failed — fall back
  }

  return `https://${server}`
}

// Login with username/password
export async function matrixLogin(
  server: string,
  username: string,
  password: string,
): Promise<void> {
  const hs = await resolveHomeserver(server)

  const res = await fetch(`${hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user: username,
      },
      password,
      initial_device_display_name: 'Console',
    }),
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error || `Login failed: ${res.status}`)
  }

  const data = await res.json()
  persistSession(data.access_token, data.user_id, data.device_id, hs)

  // Store refresh token if provided
  if (data.refresh_token) {
    await setMeta('matrix_refresh_token', data.refresh_token)
  }
}

// Logout
export async function matrixLogout(): Promise<void> {
  if (accessToken && homeserver) {
    try {
      await fetch(`${homeserver}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      })
    } catch {
      // Best effort
    }
  }

  await db.meta.delete('matrix_refresh_token')
  await db.meta.delete('matrixSyncToken')
  clearSession()
}

export function getMatrixAccessToken(): string | null {
  return accessToken
}

export function getMatrixUserId(): string | null {
  return userId
}

export function getMatrixHomeserver(): string | null {
  return homeserver
}

export function getMatrixDeviceId(): string | null {
  return deviceId
}

export function isMatrixConnected(): boolean {
  return !!accessToken && !!homeserver && !!userId
}
