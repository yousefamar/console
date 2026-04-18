// Gmail API — proxied through the hub.
//
// Every function here hits `${getHubUrl()}/mail/*`. The hub owns the access
// token; the browser never sends an Authorization header to googleapis.com.
// See server/src/routes/mail.ts for the corresponding routes and
// server/src/gmail-client.ts for the upstream implementation.
//
// On 401 from the hub we assume the hub tried to refresh and gave up, which
// means the user needs to re-sign-in. We fire the auth-expired listener so
// the shell can show a sign-in prompt.

import { getHubUrl } from '@/hub'
import { notifyAuthExpired } from './auth'
import type {
  GmailProfile,
  GmailMessage,
  GmailThread,
  GmailHistoryRecord,
  SendAsAlias,
} from './types'
import type { EmailAttachment } from '@/utils/email'

async function hubRequest<T>(
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string | string[]> } = {},
): Promise<T> {
  const url = new URL(`${getHubUrl()}${path}`)
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item)
      } else {
        url.searchParams.set(k, v)
      }
    }
  }

  const headers: Record<string, string> = opts.body
    ? { 'Content-Type': 'application/json' }
    : {}
  const body = opts.body ? JSON.stringify(opts.body) : undefined

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body,
  })

  if (!res.ok) {
    if (res.status === 401) {
      notifyAuthExpired()
      throw new Error('Session expired. Please sign in again.')
    }
    const text = await res.text()
    throw new Error(`Gmail API ${res.status}: ${text}`)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

// Profile
export async function getProfile(): Promise<GmailProfile> {
  return hubRequest<GmailProfile>('/mail/profile')
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
  }
  if (opts.pageToken) params.pageToken = opts.pageToken
  return hubRequest('/mail/threads', { params })
}

export async function getThread(threadId: string, format: 'full' | 'metadata' = 'full'): Promise<GmailThread> {
  return hubRequest<GmailThread>(`/mail/threads/${encodeURIComponent(threadId)}`, {
    params: { format },
  })
}

// Thread-level operations
export async function archiveThread(threadId: string): Promise<void> {
  await hubRequest(`/mail/threads/${encodeURIComponent(threadId)}/archive`, { method: 'POST' })
}

export async function unarchiveThread(threadId: string): Promise<void> {
  await hubRequest(`/mail/threads/${encodeURIComponent(threadId)}/unarchive`, { method: 'POST' })
}

export async function trashThread(threadId: string): Promise<void> {
  await hubRequest(`/mail/threads/${encodeURIComponent(threadId)}/trash`, { method: 'POST' })
}

export async function markThreadRead(threadId: string): Promise<void> {
  await hubRequest(`/mail/threads/${encodeURIComponent(threadId)}/read`, { method: 'POST' })
}

export async function markThreadUnread(threadId: string): Promise<void> {
  await hubRequest(`/mail/threads/${encodeURIComponent(threadId)}/unread`, { method: 'POST' })
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
  return hubRequest<GmailMessage>('/mail/send', {
    method: 'POST',
    body: {
      from: opts.from,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      body: opts.html,
      html: true,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      threadId: opts.threadId,
      attachments: opts.attachments,
    },
  })
}

// Attachments
export async function getAttachment(messageId: string, attachmentId: string): Promise<string> {
  const result = await hubRequest<{ data: string; size: number }>(
    `/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  )
  return result.data // base64url encoded
}

// History (for incremental sync)
export async function listHistory(startHistoryId: string, pageToken?: string): Promise<{
  history: GmailHistoryRecord[]
  historyId: string
  nextPageToken?: string
}> {
  const params: Record<string, string> = { startHistoryId }
  if (pageToken) params.pageToken = pageToken
  return hubRequest('/mail/history', { params })
}

// Gmail labels (for mapping Label_* IDs to human-readable names)
export async function getLabels(): Promise<{ id: string; name: string }[]> {
  return hubRequest<{ id: string; name: string }[]>('/mail/labels')
}

// Send-As aliases (hub already maps to { email, name, isDefault })
export async function getSendAsAliases(): Promise<SendAsAlias[]> {
  return hubRequest<SendAsAlias[]>('/mail/aliases')
}

// People API — search contacts (hub-proxied)
export async function searchContacts(query: string): Promise<{ name: string; email: string }[]> {
  if (!query) return []
  try {
    return await hubRequest<{ name: string; email: string }[]>('/mail/contacts', {
      params: { q: query },
    })
  } catch {
    return []
  }
}
