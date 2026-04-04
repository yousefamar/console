// ============================================================================
// Calendar Multi-Account Token Manager
// Primary account delegates to gmail/auth.ts. Additional accounts have
// their own OAuth tokens stored in localStorage + IDB.
// ============================================================================

import { getAccessToken } from '@/gmail/auth'
import { getMeta, setMeta, db } from '@/db'
import { useUiStore } from '@/store/ui'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'
const ACCOUNTS_META_KEY = 'calendar_accounts'

export interface CalendarAccount {
  email: string
  isPrimary: boolean
}

// --------------------------------------------------------------------------
// Account list
// --------------------------------------------------------------------------

export async function getAccounts(): Promise<CalendarAccount[]> {
  const primaryEmail = useUiStore.getState().userEmail
  const stored = await getMeta(ACCOUNTS_META_KEY)
  const additionalEmails: string[] = stored ? JSON.parse(stored) : []

  const accounts: CalendarAccount[] = []

  // Primary account (Gmail) — always first if signed in
  if (primaryEmail) {
    accounts.push({ email: primaryEmail, isPrimary: true })
  }

  // Additional calendar-only accounts
  for (const email of additionalEmails) {
    if (email !== primaryEmail) {
      accounts.push({ email, isPrimary: false })
    }
  }

  return accounts
}

// --------------------------------------------------------------------------
// Token management
// --------------------------------------------------------------------------

export async function getTokenForAccount(email: string): Promise<string | null> {
  // Check if this is the primary Gmail account
  const primaryEmail = useUiStore.getState().userEmail
  if (email === primaryEmail) {
    return getAccessToken()
  }

  // Additional account — check localStorage
  const token = localStorage.getItem(`cal_token_${email}`)
  const expiry = parseInt(localStorage.getItem(`cal_expiry_${email}`) || '0')

  if (token && Date.now() < expiry) {
    return token
  }

  // Try refresh
  const refreshed = await refreshCalendarToken(email)
  if (refreshed) {
    return localStorage.getItem(`cal_token_${email}`)
  }

  return null
}

export async function refreshCalendarToken(email: string): Promise<boolean> {
  const refreshToken = await getMeta(`cal_refresh_${email}`)
  if (!refreshToken) return false

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!res.ok) {
      if (res.status === 401) {
        // Refresh token revoked
        await db.meta.delete(`cal_refresh_${email}`)
      }
      return false
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    persistAccountToken(email, data.access_token, data.expires_in)
    return true
  } catch {
    return false
  }
}

function persistAccountToken(email: string, token: string, expiresIn: number) {
  const expiry = Date.now() + expiresIn * 1000
  localStorage.setItem(`cal_token_${email}`, token)
  localStorage.setItem(`cal_expiry_${email}`, String(expiry))

  // Schedule proactive refresh
  const refreshInMs = Math.max((expiresIn - 300) * 1000, 0)
  setTimeout(() => refreshCalendarToken(email), refreshInMs)
}

// --------------------------------------------------------------------------
// Add / Remove accounts
// --------------------------------------------------------------------------

export async function addCalendarAccount(): Promise<CalendarAccount> {
  // Load Google Identity Services (should already be loaded by gmail/auth)
  await waitForGis()

  return new Promise((resolve, reject) => {
    const codeClient = google.accounts.oauth2.initCodeClient({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      scope: CALENDAR_SCOPE,
      ux_mode: 'popup',
      callback: async (response) => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }
        try {
          // Exchange code for tokens
          const res = await fetch('/api/auth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: response.code }),
          })
          if (!res.ok) {
            reject(new Error('Token exchange failed'))
            return
          }
          const data = await res.json() as {
            access_token: string
            expires_in: number
            refresh_token?: string
          }

          // Discover which account this is
          const infoRes = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
            headers: { Authorization: `Bearer ${data.access_token}` },
          })
          const info = await infoRes.json() as { email: string }
          const email = info.email

          // Store tokens
          persistAccountToken(email, data.access_token, data.expires_in)
          if (data.refresh_token) {
            await setMeta(`cal_refresh_${email}`, data.refresh_token)
          }

          // Add to accounts list
          const stored = await getMeta(ACCOUNTS_META_KEY)
          const emails: string[] = stored ? JSON.parse(stored) : []
          if (!emails.includes(email)) {
            emails.push(email)
            await setMeta(ACCOUNTS_META_KEY, JSON.stringify(emails))
          }

          const account: CalendarAccount = { email, isPrimary: false }
          resolve(account)
        } catch (err) {
          reject(err)
        }
      },
    })
    codeClient.requestCode()
  })
}

export async function removeCalendarAccount(email: string): Promise<void> {
  // Revoke refresh token (best effort)
  const refreshToken = await getMeta(`cal_refresh_${email}`)
  if (refreshToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {})
  }

  // Clear tokens
  localStorage.removeItem(`cal_token_${email}`)
  localStorage.removeItem(`cal_expiry_${email}`)
  await db.meta.delete(`cal_refresh_${email}`)

  // Remove from accounts list
  const stored = await getMeta(ACCOUNTS_META_KEY)
  const emails: string[] = stored ? JSON.parse(stored) : []
  const updated = emails.filter((e) => e !== email)
  await setMeta(ACCOUNTS_META_KEY, JSON.stringify(updated))

  // Clean up calendars and events for this account
  const cals = await db.calendarList.where('accountEmail').equals(email).toArray()
  if (cals.length > 0) {
    await db.calendarList.where('accountEmail').equals(email).delete()
  }
  const events = await db.calendarEvents.where('accountEmail').equals(email).toArray()
  if (events.length > 0) {
    await db.calendarEvents.where('accountEmail').equals(email).delete()
  }
}

// Wait for Google Identity Services to be loaded
function waitForGis(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof google !== 'undefined' && google.accounts) {
      resolve()
      return
    }
    // Poll briefly — should already be loaded by gmail auth
    const interval = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts) {
        clearInterval(interval)
        resolve()
      }
    }, 100)
    setTimeout(() => { clearInterval(interval); resolve() }, 3000)
  })
}
