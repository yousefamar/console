// Gmail auth — thin façade around the hub's Google OAuth.
//
// The hub owns the access token; the browser just asks the hub "am I signed
// in?" on startup and tracks that in memory. Sign-in opens the hub's
// /auth/google/start (popup in the browser, Chrome Custom Tabs in the APK)
// and polls /auth/google/poll for completion. Sign-out POSTs to
// /auth/logout/google so the hub forgets the credentials.

import { getHubUrl } from '@/hub'
import { isNative, onNativeAuthReturn } from '@/platform'

let signedIn = false
let userEmail: string | null = null

// --- Auth-state listeners ----------------------------------------------------

type AuthExpiredListener = () => void
let authExpiredListeners: AuthExpiredListener[] = []

export function onAuthExpired(fn: AuthExpiredListener): () => void {
  authExpiredListeners.push(fn)
  return () => { authExpiredListeners = authExpiredListeners.filter((l) => l !== fn) }
}

export function notifyAuthExpired() {
  signedIn = false
  userEmail = null
  for (const fn of authExpiredListeners) fn()
}

// --- Status --------------------------------------------------------------

interface HubStatus {
  google: {
    connected: boolean
    accounts: Array<{ email: string; isPrimary: boolean; hasToken: boolean }>
  }
}

async function fetchStatus(): Promise<HubStatus | null> {
  try {
    const res = await fetch(`${getHubUrl()}/auth/status`)
    if (!res.ok) return null
    return await res.json() as HubStatus
  } catch {
    return null
  }
}

export async function initAuth(): Promise<void> {
  const status = await fetchStatus()
  if (!status) {
    signedIn = false
    userEmail = null
    return
  }
  const primary = status.google.accounts.find((a) => a.isPrimary) ?? status.google.accounts[0]
  signedIn = !!primary?.hasToken
  userEmail = primary?.email ?? null
}

export function isSignedIn(): boolean {
  return signedIn
}

export function getUserEmail(): string | null {
  return userEmail
}

// --- Sign-in / sign-out --------------------------------------------------

export function signIn(popup?: Window | null): Promise<string> {
  const native = isNative()
  const startUrl = `${getHubUrl()}/auth/google/start${native ? '?callback=app' : ''}`

  // Popup must be opened by the caller in the click handler to preserve user
  // gesture. In the APK the native shell intercepts window.open and launches
  // Chrome Custom Tabs.
  if (popup === undefined) {
    popup = window.open(
      startUrl,
      'google-auth',
      'width=500,height=600,menubar=no,toolbar=no',
    )
  }

  return new Promise((resolve, reject) => {
    const hubUrl = getHubUrl()

    if (!popup && !native) {
      reject(new Error('Popup blocked'))
      return
    }

    let unsubscribeNative: (() => void) | null = null
    let settled = false
    let interval: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      settled = true
      if (interval) clearInterval(interval)
      if (timeout) clearTimeout(timeout)
      if (unsubscribeNative) unsubscribeNative()
      if (popup && !popup.closed) {
        try { popup.close() } catch { /* ignore */ }
      }
    }

    const finish = async (email: string) => {
      cleanup()
      await initAuth()
      resolve(email)
    }

    // APK path — native shell dispatches a DOM event after `console://auth/done`.
    if (native) {
      unsubscribeNative = onNativeAuthReturn(async () => {
        if (settled) return
        try {
          const res = await fetch(`${hubUrl}/auth/google/poll`)
          const data = await res.json() as { done: boolean; email?: string }
          if (data.done && data.email) await finish(data.email)
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    }

    // Polling path — also runs in native as a safety net in case the deep
    // link fires before the listener is attached, or the event is lost on
    // cold start.
    interval = setInterval(async () => {
      if (settled) return
      if (popup && !native && popup.closed) {
        cleanup()
        reject(new Error('Sign-in cancelled'))
        return
      }
      try {
        const res = await fetch(`${hubUrl}/auth/google/poll`)
        if (!res.ok) return
        const data = await res.json() as { done: boolean; email?: string }
        if (data.done && data.email) await finish(data.email)
      } catch {
        // keep polling
      }
    }, 1000)

    timeout = setTimeout(() => {
      if (settled) return
      cleanup()
      reject(new Error('Sign-in timed out'))
    }, 5 * 60 * 1000)
  })
}

export async function signOut(): Promise<void> {
  // Tell the hub to drop the primary Google account's refresh + access tokens.
  try {
    await fetch(`${getHubUrl()}/auth/logout/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  } catch {
    // Best effort — we clear local state regardless.
  }
  signedIn = false
  userEmail = null
}
