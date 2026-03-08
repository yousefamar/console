import { getAccessToken, notifyAuthExpired, refreshAccessToken } from './auth'
import type {
  GmailProfile,
  GmailMessage,
  GmailThread,
  GmailHistoryRecord,
  GmailSendAs,
  SendAsAlias,
} from './types'
import { encodeBase64Url, buildRawEmail, type EmailAttachment } from '@/utils/email'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string | string[]> } = {},
): Promise<T> {
  const token = await getAccessToken()
  if (!token) {
    notifyAuthExpired()
    throw new Error('Session expired. Please sign in again.')
  }

  const url = new URL(`${BASE}${path}`)
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          url.searchParams.append(k, item)
        }
      } else {
        url.searchParams.set(k, v)
      }
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const body = opts.body ? JSON.stringify(opts.body) : undefined

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body,
  })

  if (!res.ok) {
    if (res.status === 401) {
      // Try refreshing the token silently, then retry once
      const refreshed = await refreshAccessToken()
      if (refreshed) {
        const newToken = await getAccessToken()
        if (newToken) {
          const retryRes = await fetch(url.toString(), {
            method: opts.method ?? 'GET',
            headers: { ...headers, Authorization: `Bearer ${newToken}` },
            body,
          })
          if (retryRes.ok) {
            return retryRes.json() as Promise<T>
          }
        }
      }
      // Refresh failed or retry failed — user must re-auth
      notifyAuthExpired()
      throw new Error('Session expired. Please sign in again.')
    }
    const text = await res.text()
    throw new Error(`Gmail API ${res.status}: ${text}`)
  }

  return res.json() as Promise<T>
}

// Profile
export async function getProfile(): Promise<GmailProfile> {
  return request<GmailProfile>('/profile')
}

// Threads
export async function listThreads(opts: {
  maxResults?: number
  pageToken?: string
  q?: string
} = {}): Promise<{ threads: { id: string; historyId: string; snippet: string }[]; nextPageToken?: string; resultSizeEstimate: number }> {
  const params: Record<string, string> = {
    maxResults: String(opts.maxResults ?? 50),
    q: opts.q ?? 'in:inbox',
    includeSpamTrash: 'false',
  }
  if (opts.pageToken) params.pageToken = opts.pageToken
  return request('/threads', { params })
}

export async function getThread(threadId: string, format: 'full' | 'metadata' = 'full'): Promise<GmailThread> {
  return request<GmailThread>(`/threads/${threadId}`, {
    params: { format },
  })
}

// Messages
export async function getMessage(messageId: string, format: 'full' | 'metadata' = 'full'): Promise<GmailMessage> {
  return request<GmailMessage>(`/messages/${messageId}`, {
    params: { format },
  })
}

export async function modifyMessage(
  messageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): Promise<GmailMessage> {
  return request<GmailMessage>(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: { addLabelIds, removeLabelIds },
  })
}

export async function trashMessage(messageId: string): Promise<GmailMessage> {
  return request<GmailMessage>(`/messages/${messageId}/trash`, {
    method: 'POST',
  })
}

// Thread-level operations (modify all messages in thread)
export async function archiveThread(threadId: string): Promise<void> {
  await request(`/threads/${threadId}/modify`, {
    method: 'POST',
    body: { removeLabelIds: ['INBOX'] },
  })
}

export async function unarchiveThread(threadId: string): Promise<void> {
  await request(`/threads/${threadId}/modify`, {
    method: 'POST',
    body: { addLabelIds: ['INBOX'] },
  })
}

export async function trashThread(threadId: string): Promise<void> {
  await request(`/threads/${threadId}/trash`, {
    method: 'POST',
  })
}

export async function markThreadRead(threadId: string): Promise<void> {
  await request(`/threads/${threadId}/modify`, {
    method: 'POST',
    body: { removeLabelIds: ['UNREAD'] },
  })
}

export async function markThreadUnread(threadId: string): Promise<void> {
  await request(`/threads/${threadId}/modify`, {
    method: 'POST',
    body: { addLabelIds: ['UNREAD'] },
  })
}

// Sending
export async function sendEmail(opts: {
  from: string
  to: string
  cc?: string
  subject: string
  html: string
  inReplyTo?: string
  references?: string
  threadId?: string
  attachments?: EmailAttachment[]
}): Promise<GmailMessage> {
  const raw = buildRawEmail(opts)
  const encoded = encodeBase64Url(raw)

  const body: { raw: string; threadId?: string } = { raw: encoded }
  if (opts.threadId) body.threadId = opts.threadId

  return request<GmailMessage>('/messages/send', {
    method: 'POST',
    body,
  })
}

// Attachments
export async function getAttachment(messageId: string, attachmentId: string): Promise<string> {
  const result = await request<{ data: string; size: number }>(
    `/messages/${messageId}/attachments/${attachmentId}`,
  )
  return result.data // base64url encoded
}

// History (for incremental sync)
export async function listHistory(startHistoryId: string, pageToken?: string): Promise<{
  history: GmailHistoryRecord[]
  historyId: string
  nextPageToken?: string
}> {
  const params: Record<string, string | string[]> = {
    startHistoryId,
    historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
    labelId: 'INBOX',
  }
  if (pageToken) params.pageToken = pageToken
  return request('/history', { params })
}

// Search
export async function searchThreads(query: string, maxResults = 20): Promise<{ id: string; snippet: string }[]> {
  const result = await listThreads({ q: query, maxResults })
  return result.threads ?? []
}

// Send-As aliases
export async function getSendAsAliases(): Promise<SendAsAlias[]> {
  const result = await request<{ sendAs: GmailSendAs[] }>('/settings/sendAs')
  return (result.sendAs ?? []).map((s) => ({
    email: s.sendAsEmail,
    name: s.displayName || '',
    isDefault: s.isDefault ?? s.isPrimary ?? false,
  }))
}

// People API — search contacts
export async function searchContacts(query: string): Promise<{ name: string; email: string }[]> {
  const token = await getAccessToken()
  if (!token || !query) return []

  const results: { name: string; email: string }[] = []

  // Search "other contacts" (people you've emailed)
  try {
    const otherUrl = new URL('https://people.googleapis.com/v1/otherContacts:search')
    otherUrl.searchParams.set('query', query)
    otherUrl.searchParams.set('readMask', 'names,emailAddresses')
    otherUrl.searchParams.set('pageSize', '10')

    const otherRes = await fetch(otherUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (otherRes.ok) {
      const data = await otherRes.json()
      for (const r of data.results ?? []) {
        const person = r.person
        const email = person?.emailAddresses?.[0]?.value
        if (email) {
          const name = person?.names?.[0]?.displayName ?? ''
          results.push({ name, email })
        }
      }
    } else {
      console.warn('People API otherContacts search failed:', otherRes.status, await otherRes.text())
    }
  } catch (err) {
    console.warn('People API otherContacts search error:', err)
  }

  // Search saved contacts
  try {
    const contactsUrl = new URL('https://people.googleapis.com/v1/people:searchContacts')
    contactsUrl.searchParams.set('query', query)
    contactsUrl.searchParams.set('readMask', 'names,emailAddresses')
    contactsUrl.searchParams.set('pageSize', '10')

    const contactsRes = await fetch(contactsUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (contactsRes.ok) {
      const data = await contactsRes.json()
      for (const r of data.results ?? []) {
        const person = r.person
        const email = person?.emailAddresses?.[0]?.value
        if (email && !results.some((c) => c.email === email)) {
          const name = person?.names?.[0]?.displayName ?? ''
          results.push({ name, email })
        }
      }
    } else {
      console.warn('People API contacts search failed:', contactsRes.status, await contactsRes.text())
    }
  } catch (err) {
    console.warn('People API contacts search error:', err)
  }

  return results
}
