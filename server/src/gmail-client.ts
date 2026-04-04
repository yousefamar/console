// Gmail REST API client — server-side port of src/gmail/api.ts
// Uses auth-store for token management instead of browser localStorage

import type { AuthStore } from './auth-store.js'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const PEOPLE_BASE = 'https://people.googleapis.com/v1'

export class GmailClient {
  constructor(private authStore: AuthStore) {}

  private async request<T>(
    path: string,
    opts: {
      method?: string
      body?: unknown
      params?: Record<string, string | string[] | undefined>
      account?: string
    } = {},
  ): Promise<T> {
    const token = await this.authStore.getGoogleToken(opts.account)
    if (!token) {
      throw new GmailApiError(401, 'Not authenticated. Run: con auth login google')
    }

    const url = new URL(`${GMAIL_BASE}${path}`)
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v === undefined) continue
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, item)
        } else {
          url.searchParams.set(k, v)
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const body = opts.body ? JSON.stringify(opts.body) : undefined

    let res = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body })

    // Auto-refresh on 401
    if (res.status === 401) {
      const email = opts.account || this.authStore.getPrimaryGoogleAccount()?.email
      if (email) {
        const refreshed = await this.authStore.refreshGoogleToken(email)
        if (refreshed) {
          const newToken = await this.authStore.getGoogleToken(email)
          if (newToken) {
            res = await fetch(url.toString(), {
              method: opts.method ?? 'GET',
              headers: { ...headers, Authorization: `Bearer ${newToken}` },
              body,
            })
          }
        }
      }
    }

    if (!res.ok) {
      const text = await res.text()
      throw new GmailApiError(res.status, `Gmail API ${res.status}: ${text}`)
    }

    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async getProfile(account?: string) {
    return this.request<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }>('/profile', { account })
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  async listThreads(opts: { q?: string; maxResults?: string; pageToken?: string; account?: string } = {}) {
    return this.request<{
      threads?: Array<{ id: string; historyId: string; snippet: string }>
      nextPageToken?: string
      resultSizeEstimate: number
    }>('/threads', {
      account: opts.account,
      params: {
        q: opts.q ?? 'in:inbox',
        maxResults: opts.maxResults ?? '50',
        includeSpamTrash: 'false',
        pageToken: opts.pageToken,
      },
    })
  }

  async getThread(threadId: string, opts?: { format?: string; account?: string }) {
    return this.request(`/threads/${threadId}`, {
      account: opts?.account,
      params: { format: opts?.format ?? 'full' },
    })
  }

  // -------------------------------------------------------------------------
  // Thread operations
  // -------------------------------------------------------------------------

  async archiveThread(threadId: string, account?: string) {
    return this.request(`/threads/${threadId}/modify`, {
      method: 'POST',
      body: { removeLabelIds: ['INBOX'] },
      account,
    })
  }

  async unarchiveThread(threadId: string, account?: string) {
    return this.request(`/threads/${threadId}/modify`, {
      method: 'POST',
      body: { addLabelIds: ['INBOX'] },
      account,
    })
  }

  async trashThread(threadId: string, account?: string) {
    return this.request(`/threads/${threadId}/trash`, { method: 'POST', account })
  }

  async markThreadRead(threadId: string, account?: string) {
    return this.request(`/threads/${threadId}/modify`, {
      method: 'POST',
      body: { removeLabelIds: ['UNREAD'] },
      account,
    })
  }

  async markThreadUnread(threadId: string, account?: string) {
    return this.request(`/threads/${threadId}/modify`, {
      method: 'POST',
      body: { addLabelIds: ['UNREAD'] },
      account,
    })
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async getMessage(messageId: string, opts?: { format?: string; account?: string }) {
    return this.request(`/messages/${messageId}`, {
      account: opts?.account,
      params: { format: opts?.format ?? 'full' },
    })
  }

  async getAttachment(messageId: string, attachmentId: string, account?: string) {
    return this.request<{ data: string; size: number }>(`/messages/${messageId}/attachments/${attachmentId}`, { account })
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async sendEmail(opts: {
    from: string
    to: string
    cc?: string
    subject: string
    html: string
    inReplyTo?: string
    references?: string
    threadId?: string
    attachments?: Array<{ filename: string; mimeType: string; data: string }>
    account?: string
  }) {
    const raw = buildRawEmail(opts)
    const encoded = encodeBase64Url(raw)
    const body: { raw: string; threadId?: string } = { raw: encoded }
    if (opts.threadId) body.threadId = opts.threadId

    return this.request('/messages/send', { method: 'POST', body, account: opts.account })
  }

  // -------------------------------------------------------------------------
  // History (for browser incremental sync)
  // -------------------------------------------------------------------------

  async listHistory(startHistoryId: string, opts?: { pageToken?: string; account?: string }) {
    return this.request<{
      history?: unknown[]
      historyId: string
      nextPageToken?: string
    }>('/history', {
      account: opts?.account,
      params: {
        startHistoryId,
        historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
        labelId: 'INBOX',
        pageToken: opts?.pageToken,
      },
    })
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async getLabels(account?: string) {
    const result = await this.request<{ labels: Array<{ id: string; name: string; type: string }> }>('/labels', { account })
    return (result.labels ?? [])
      .filter((l) => l.type === 'user')
      .map((l) => ({ id: l.id, name: l.name }))
  }

  // -------------------------------------------------------------------------
  // Send-As aliases
  // -------------------------------------------------------------------------

  async getSendAsAliases(account?: string) {
    const result = await this.request<{
      sendAs: Array<{ sendAsEmail: string; displayName: string; isDefault?: boolean; isPrimary?: boolean }>
    }>('/settings/sendAs', { account })
    return (result.sendAs ?? []).map((s) => ({
      email: s.sendAsEmail,
      name: s.displayName || '',
      isDefault: s.isDefault ?? s.isPrimary ?? false,
    }))
  }

  // -------------------------------------------------------------------------
  // Contacts (People API)
  // -------------------------------------------------------------------------

  async searchContacts(query: string, account?: string) {
    const token = await this.authStore.getGoogleToken(account)
    if (!token || !query) return []

    const results: Array<{ name: string; email: string }> = []

    // Other contacts
    try {
      const url = new URL(`${PEOPLE_BASE}/otherContacts:search`)
      url.searchParams.set('query', query)
      url.searchParams.set('readMask', 'names,emailAddresses')
      url.searchParams.set('pageSize', '10')
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const data = await res.json() as any
        for (const r of data.results ?? []) {
          const email = r.person?.emailAddresses?.[0]?.value
          if (email) results.push({ name: r.person?.names?.[0]?.displayName ?? '', email })
        }
      }
    } catch { /* ignore */ }

    // Saved contacts
    try {
      const url = new URL(`${PEOPLE_BASE}/people:searchContacts`)
      url.searchParams.set('query', query)
      url.searchParams.set('readMask', 'names,emailAddresses')
      url.searchParams.set('pageSize', '10')
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const data = await res.json() as any
        for (const r of data.results ?? []) {
          const email = r.person?.emailAddresses?.[0]?.value
          if (email && !results.some((c) => c.email === email)) {
            results.push({ name: r.person?.names?.[0]?.displayName ?? '', email })
          }
        }
      }
    } catch { /* ignore */ }

    return results
  }
}

// -------------------------------------------------------------------------
// Email building utilities (ported from src/utils/email.ts)
// -------------------------------------------------------------------------

function encodeBase64Url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function encodeHtmlBase64(html: string): string {
  return btoa(unescape(encodeURIComponent(html))).match(/.{1,76}/g)?.join('\n') ?? ''
}

function buildRawEmail(opts: {
  from: string
  to: string
  cc?: string
  subject: string
  html: string
  inReplyTo?: string
  references?: string
  attachments?: Array<{ filename: string; mimeType: string; data: string }>
}): string {
  const hasAttachments = opts.attachments && opts.attachments.length > 0

  const buildHeaders = (contentType: string): string[] => [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    opts.cc ? `Cc: ${opts.cc}` : '',
    `Subject: ${opts.subject}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : '',
    opts.references ? `References: ${opts.references}` : '',
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
  ].filter(Boolean)

  if (!hasAttachments) {
    const boundary = `boundary_${Date.now()}`
    return [
      ...buildHeaders(`multipart/alternative; boundary="${boundary}"`),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodeHtmlBase64(opts.html),
      '',
      `--${boundary}--`,
    ].join('\r\n')
  }

  const boundary = `mixed_${Date.now()}`
  const lines = [
    ...buildHeaders(`multipart/mixed; boundary="${boundary}"`),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeHtmlBase64(opts.html),
    '',
  ]

  for (const att of opts.attachments!) {
    lines.push(`--${boundary}`)
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`)
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`)
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(att.data.match(/.{1,76}/g)?.join('\n') ?? '')
    lines.push('')
  }

  lines.push(`--${boundary}--`)
  return lines.join('\r\n')
}

class GmailApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'GmailApiError'
  }
}
