// Matrix auth — thin browser façade around the hub's `/matrix/hub/login`,
// `/matrix/hub/logout`, and `/matrix/hub/status` endpoints.
//
// The hub owns the access token and device_id. The browser caches identity
// metadata (user_id, homeserver, device_id) in localStorage for display +
// local-echo ownership checks, and calls `initMatrixAuth()` on boot to
// hydrate that cache from the hub — which matters for any fresh localStorage
// (e.g. APK WebView's first launch, clearing browser data) where the hub
// might already be signed in but the browser doesn't know yet.

import { db } from '@/db'
import { hubFetch } from '@/hub'

const MATRIX_USER_KEY = 'matrix_user_id'
const MATRIX_DEVICE_KEY = 'matrix_device_id'
const MATRIX_HS_KEY = 'matrix_homeserver'

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

function persistSession(user: string, device: string, hs: string) {
  userId = user
  deviceId = device
  homeserver = hs
  localStorage.setItem(MATRIX_USER_KEY, user)
  localStorage.setItem(MATRIX_DEVICE_KEY, device)
  localStorage.setItem(MATRIX_HS_KEY, hs)
  notifyAuthChange()
}

function clearSession() {
  userId = null
  deviceId = null
  homeserver = null
  localStorage.removeItem(MATRIX_USER_KEY)
  localStorage.removeItem(MATRIX_DEVICE_KEY)
  localStorage.removeItem(MATRIX_HS_KEY)
  // Legacy token key (pre-hub-auth); clear in case an older build stored one.
  localStorage.removeItem('matrix_access_token')
  notifyAuthChange()
}

// Resolve homeserver URL from a user-provided server name.
// Uses unauthenticated .well-known discovery — no credentials involved,
// so it's fine for the browser to do this directly.
export async function resolveHomeserver(server: string): Promise<string> {
  if (server.startsWith('http://') || server.startsWith('https://')) {
    return server.replace(/\/+$/, '')
  }

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

// Login via hub — hub holds the access token from here on.
export async function matrixLogin(
  server: string,
  username: string,
  password: string,
): Promise<void> {
  const hs = await resolveHomeserver(server)
  // Derive a full MXID if user passed just the localpart.
  const serverName = hs.replace(/^https?:\/\//, '').replace(/:\d+$/, '')
  const fullUserId = username.startsWith('@')
    ? username
    : `@${username}:${serverName}`

  const data = await hubFetch<{
    ok: true
    userId: string
    deviceId: string
  }>('/matrix/hub/login', {
    method: 'POST',
    body: JSON.stringify({ homeserver: hs, userId: fullUserId, password }),
  })

  persistSession(data.userId, data.deviceId, hs)
}

// Logout via hub — hub invalidates the homeserver session and clears creds.
export async function matrixLogout(): Promise<void> {
  try {
    await hubFetch('/matrix/hub/logout', { method: 'POST' })
  } catch {
    // Best effort — clear local metadata either way.
  }

  await db.meta.delete('matrix_refresh_token')
  await db.meta.delete('matrixSyncToken')
  clearSession()
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
  return !!homeserver && !!userId
}

// Hydrate browser cache from the hub. Call on app boot before using
// `isMatrixConnected()` — without it, a fresh WebView (APK's first launch,
// or a cleared browser) would incorrectly think it needs to re-login.
export async function initMatrixAuth(): Promise<void> {
  try {
    const status = await hubFetch<{
      hasCredentials: boolean
      userId?: string
      deviceId?: string
      homeserver?: string
    }>('/matrix/hub/status')

    if (status.hasCredentials && status.userId && status.deviceId && status.homeserver) {
      persistSession(status.userId, status.deviceId, status.homeserver)
    } else if (!status.hasCredentials && (userId || deviceId || homeserver)) {
      // Hub says no session — browser had stale metadata. Clear it so the
      // UI prompts for login rather than silently failing every API call.
      clearSession()
    }
  } catch {
    // Hub unreachable — leave whatever's in localStorage alone; the UI will
    // either show as connected (if metadata was cached) or prompt for login.
  }
}
