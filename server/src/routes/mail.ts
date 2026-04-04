// Gmail proxy routes — proxies Gmail API calls with hub-managed tokens

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GmailClient } from '../gmail-client.js'

export function handleMailRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  gmail: GmailClient,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const error = (status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }

  const handleAsync = (fn: () => Promise<void>) => {
    fn().catch((err: Error) => {
      const status = (err as any).status || 500
      error(status, err.message)
    })
    return true
  }

  const account = url.searchParams.get('account') || undefined

  // GET /mail/threads
  if (path === '/mail/threads' && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await gmail.listThreads({
        q: url.searchParams.get('q') || undefined,
        maxResults: url.searchParams.get('maxResults') || undefined,
        pageToken: url.searchParams.get('pageToken') || undefined,
        account,
      })
      json(data)
    })
  }

  // GET /mail/threads/:id
  const threadMatch = path.match(/^\/mail\/threads\/([^/]+)$/)
  if (threadMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await gmail.getThread(threadMatch[1]!, {
        format: url.searchParams.get('format') || undefined,
        account,
      })
      json(data)
    })
  }

  // POST /mail/threads/:id/archive
  const archiveMatch = path.match(/^\/mail\/threads\/([^/]+)\/archive$/)
  if (archiveMatch && req.method === 'POST') {
    return handleAsync(async () => {
      await gmail.archiveThread(archiveMatch[1]!, account)
      json({ ok: true })
    })
  }

  // POST /mail/threads/:id/unarchive
  const unarchiveMatch = path.match(/^\/mail\/threads\/([^/]+)\/unarchive$/)
  if (unarchiveMatch && req.method === 'POST') {
    return handleAsync(async () => {
      await gmail.unarchiveThread(unarchiveMatch[1]!, account)
      json({ ok: true })
    })
  }

  // POST /mail/threads/:id/trash
  const trashMatch = path.match(/^\/mail\/threads\/([^/]+)\/trash$/)
  if (trashMatch && req.method === 'POST') {
    return handleAsync(async () => {
      await gmail.trashThread(trashMatch[1]!, account)
      json({ ok: true })
    })
  }

  // POST /mail/threads/:id/read
  const readMatch = path.match(/^\/mail\/threads\/([^/]+)\/read$/)
  if (readMatch && req.method === 'POST') {
    return handleAsync(async () => {
      await gmail.markThreadRead(readMatch[1]!, account)
      json({ ok: true })
    })
  }

  // POST /mail/threads/:id/unread
  const unreadMatch = path.match(/^\/mail\/threads\/([^/]+)\/unread$/)
  if (unreadMatch && req.method === 'POST') {
    return handleAsync(async () => {
      await gmail.markThreadUnread(unreadMatch[1]!, account)
      json({ ok: true })
    })
  }

  // POST /mail/threads/:id/snooze
  const snoozeMatch = path.match(/^\/mail\/threads\/([^/]+)\/snooze$/)
  if (snoozeMatch && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      // Snooze = archive + store snooze time (handled by browser/CLI)
      await gmail.archiveThread(snoozeMatch[1]!, account)
      json({ ok: true, snoozedUntil: body.until })
    })
  }

  // POST /mail/threads/:id/unsnooze
  const unsnoozeMatch = path.match(/^\/mail\/threads\/([^/]+)\/unsnooze$/)
  if (unsnoozeMatch && req.method === 'POST') {
    return handleAsync(async () => {
      await gmail.unarchiveThread(unsnoozeMatch[1]!, account)
      json({ ok: true })
    })
  }

  // GET /mail/threads/:id/attachments
  const threadAttMatch = path.match(/^\/mail\/threads\/([^/]+)\/attachments$/)
  if (threadAttMatch && req.method === 'GET') {
    return handleAsync(async () => {
      // Get thread, extract attachment metadata from messages
      const thread = await gmail.getThread(threadAttMatch[1]!, { account }) as any
      const attachments: Array<{ messageId: string; attachmentId: string; filename: string; mimeType: string; size: number }> = []
      for (const msg of thread.messages || []) {
        walkParts(msg.payload, msg.id, attachments)
      }
      json(attachments)
    })
  }

  // POST /mail/send
  if (path === '/mail/send' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      const result = await gmail.sendEmail({
        from: body.from || '',
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        html: body.html ? body.body : `<pre style="white-space:pre-wrap">${escapeHtml(body.body)}</pre>`,
        inReplyTo: body.inReplyTo,
        references: body.references,
        threadId: body.threadId,
        attachments: body.attachments,
        account,
      })
      json(result)
    })
  }

  // POST /mail/reply
  if (path === '/mail/reply' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      // Get thread to find the last message headers for In-Reply-To/References
      const thread = await gmail.getThread(body.threadId, { account }) as any
      const messages = thread.messages || []
      const lastMsg = messages[messages.length - 1]

      let inReplyTo = ''
      let references = ''
      let subject = ''
      let to = ''

      if (lastMsg?.payload?.headers) {
        for (const h of lastMsg.payload.headers) {
          const name = h.name.toLowerCase()
          if (name === 'message-id') inReplyTo = h.value
          if (name === 'references') references = h.value
          if (name === 'subject') subject = h.value
          if (name === 'from') to = h.value
          if (name === 'reply-to') to = h.value
        }
      }

      if (inReplyTo) {
        references = references ? `${references} ${inReplyTo}` : inReplyTo
      }
      if (!subject.toLowerCase().startsWith('re:')) subject = `Re: ${subject}`

      // For reply-all, include all recipients
      if (body.replyAll) {
        const allRecipients = new Set<string>()
        for (const h of lastMsg?.payload?.headers || []) {
          if (['to', 'cc'].includes(h.name.toLowerCase())) {
            allRecipients.add(h.value)
          }
        }
        // to is already the sender, cc is everyone else
        if (!body.cc && allRecipients.size > 0) {
          body.cc = [...allRecipients].join(', ')
        }
      }

      const html = body.html ? body.body : `<pre style="white-space:pre-wrap">${escapeHtml(body.body)}</pre>`

      // Get from address
      let from = body.from || ''
      if (!from) {
        const aliases = await gmail.getSendAsAliases(account)
        from = aliases.find((a) => a.isDefault)?.email || aliases[0]?.email || ''
      }

      const result = await gmail.sendEmail({
        from,
        to,
        cc: body.cc,
        subject,
        html,
        inReplyTo,
        references,
        threadId: body.threadId,
        account,
      })
      json(result)
    })
  }

  // POST /mail/forward
  if (path === '/mail/forward' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req))
      const thread = await gmail.getThread(body.threadId, { account }) as any
      const lastMsg = (thread.messages || []).at(-1)
      let subject = ''
      for (const h of lastMsg?.payload?.headers || []) {
        if (h.name.toLowerCase() === 'subject') subject = h.value
      }
      if (!subject.toLowerCase().startsWith('fwd:')) subject = `Fwd: ${subject}`

      let from = body.from || ''
      if (!from) {
        const aliases = await gmail.getSendAsAliases(account)
        from = aliases.find((a) => a.isDefault)?.email || aliases[0]?.email || ''
      }

      const forwardBody = body.body
        ? `<pre style="white-space:pre-wrap">${escapeHtml(body.body)}</pre>`
        : ''

      const result = await gmail.sendEmail({
        from,
        to: body.to,
        subject,
        html: forwardBody,
        threadId: body.threadId,
        account,
      })
      json(result)
    })
  }

  // GET /mail/messages/:mid/attachments/:aid
  const attMatch = path.match(/^\/mail\/messages\/([^/]+)\/attachments\/([^/]+)$/)
  if (attMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await gmail.getAttachment(attMatch[1]!, attMatch[2]!, account)
      json(data)
    })
  }

  // GET /mail/contacts
  if (path === '/mail/contacts' && req.method === 'GET') {
    return handleAsync(async () => {
      const q = url.searchParams.get('q') || ''
      const data = await gmail.searchContacts(q, account)
      json(data)
    })
  }

  // GET /mail/aliases
  if (path === '/mail/aliases' && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await gmail.getSendAsAliases(account)
      json(data)
    })
  }

  // GET /mail/profile
  if (path === '/mail/profile' && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await gmail.getProfile(account)
      json(data)
    })
  }

  // GET /mail/history
  if (path === '/mail/history' && req.method === 'GET') {
    return handleAsync(async () => {
      const startHistoryId = url.searchParams.get('startHistoryId')
      if (!startHistoryId) { error(400, 'Missing startHistoryId'); return }
      const data = await gmail.listHistory(startHistoryId, {
        pageToken: url.searchParams.get('pageToken') || undefined,
        account,
      })
      json(data)
    })
  }

  // GET /mail/labels
  if (path === '/mail/labels' && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await gmail.getLabels(account)
      json(data)
    })
  }

  // POST /mail/undo — placeholder (undo is client-side state)
  if (path === '/mail/undo' && req.method === 'POST') {
    json({ ok: false, message: 'Undo is managed by the client (browser or CLI). No server-side undo available.' })
    return true
  }

  return false
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function walkParts(
  part: any,
  messageId: string,
  attachments: Array<{ messageId: string; attachmentId: string; filename: string; mimeType: string; size: number }>,
): void {
  if (part.filename && part.body?.attachmentId) {
    attachments.push({
      messageId,
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body.size || 0,
    })
  }
  if (part.parts) {
    for (const child of part.parts) walkParts(child, messageId, attachments)
  }
}
