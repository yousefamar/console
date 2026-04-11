// ============================================================================
// Calendar Multi-Account Manager
// All OAuth and token management is handled by the hub server.
// Account list fetched from hub. Adding accounts uses hub's OAuth flow.
// ============================================================================

import { db } from '@/db'
import { hubFetch, getHubUrl } from '@/hub'

export interface CalendarAccount {
  email: string
  isPrimary: boolean
}

// --------------------------------------------------------------------------
// Account list — fetched from hub
// --------------------------------------------------------------------------

export async function getAccounts(): Promise<CalendarAccount[]> {
  try {
    return await hubFetch<CalendarAccount[]>('/cal/accounts')
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
// Add / Remove accounts
// --------------------------------------------------------------------------

export async function addCalendarAccount(popup?: Window | null): Promise<CalendarAccount> {
  const hubUrl = getHubUrl()

  if (popup === undefined) {
    popup = window.open(
      `${hubUrl}/auth/google/start`,
      'google-auth',
      'width=500,height=600,menubar=no,toolbar=no',
    )
  }

  return new Promise((resolve, reject) => {
    if (!popup) {
      reject(new Error('Popup blocked'))
      return
    }

    const interval = setInterval(async () => {
      if (popup!.closed) {
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
          popup!.close()
          resolve({ email: data.email, isPrimary: false })
        }
      } catch {
        // Network error — keep polling
      }
    }, 1000)

    setTimeout(() => {
      clearInterval(interval)
      if (!popup!.closed) popup!.close()
      reject(new Error('Sign-in timed out'))
    }, 5 * 60 * 1000)
  })
}

export async function removeCalendarAccount(email: string): Promise<void> {
  // Remove from hub
  await hubFetch(`/cal/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })

  // Clean up local calendar data
  await db.calendarList.where('accountEmail').equals(email).delete()
  await db.calendarEvents.where('accountEmail').equals(email).delete()
}
