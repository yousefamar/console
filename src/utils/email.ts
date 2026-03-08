import DOMPurify from 'dompurify'
import type { GmailMessage, GmailMessagePart, AttachmentMeta, CalendarEvent } from '@/gmail/types'

export function getHeader(message: GmailMessage, name: string): string {
  const header = message.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  )
  return header?.value ?? ''
}

export function getAllHeaders(message: GmailMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const h of message.payload.headers) {
    headers[h.name.toLowerCase()] = h.value
  }
  return headers
}

export function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/)
  if (match) {
    return { name: match[1]!.replace(/^["']|["']$/g, ''), email: match[2]! }
  }
  return { name: from, email: from }
}

export function parseAddressList(value: string): { name: string; email: string }[] {
  if (!value) return []
  // Simple split on commas that aren't inside quotes
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => parseFrom(s.trim()))
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    )
  } catch {
    return atob(base64)
  }
}

function findPart(part: GmailMessagePart, mimeType: string): GmailMessagePart | null {
  if (part.mimeType === mimeType && part.body.data) {
    return part
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPart(child, mimeType)
      if (found) return found
    }
  }
  return null
}

export function getBodyHtml(message: GmailMessage): string {
  const htmlPart = findPart(message.payload, 'text/html')
  if (htmlPart?.body.data) {
    return decodeBase64Url(htmlPart.body.data)
  }
  // Fallback to plain text wrapped in pre
  const textPart = findPart(message.payload, 'text/plain')
  if (textPart?.body.data) {
    const text = decodeBase64Url(textPart.body.data)
    return `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${escapeHtml(text)}</pre>`
  }
  // Check body directly (for simple messages without parts)
  if (message.payload.body.data) {
    if (message.payload.mimeType === 'text/html') {
      return decodeBase64Url(message.payload.body.data)
    }
    const text = decodeBase64Url(message.payload.body.data)
    return `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${escapeHtml(text)}</pre>`
  }
  return '<p style="color:#888">No content</p>'
}

export function getBodyText(message: GmailMessage): string {
  const textPart = findPart(message.payload, 'text/plain')
  if (textPart?.body.data) {
    return decodeBase64Url(textPart.body.data)
  }
  if (message.payload.body.data) {
    return decodeBase64Url(message.payload.body.data)
  }
  return ''
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'style'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
  })
}

export function getAttachments(message: GmailMessage): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = []

  function walk(part: GmailMessagePart, insideAlternative: boolean) {
    if (part.filename && part.body.attachmentId && !insideAlternative) {
      const contentIdHeader = part.headers?.find(
        (h) => h.name.toLowerCase() === 'content-id',
      )
      const contentId = contentIdHeader?.value?.replace(/^<|>$/g, '')
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size,
        contentId,
      })
    }
    if (part.parts) {
      const isAlternative = insideAlternative || part.mimeType === 'multipart/alternative'
      for (const child of part.parts) walk(child, isAlternative)
    }
  }

  walk(message.payload, false)
  return attachments
}

export function getCalendarPart(message: GmailMessage): { data?: string; attachmentId?: string; messageId: string } | undefined {
  const part = findCalendarPart(message.payload)
  if (!part) return undefined
  return {
    data: part.body.data,
    attachmentId: part.body.attachmentId,
    messageId: message.id,
  }
}

export function parseCalendarData(base64Data: string): CalendarEvent | undefined {
  const ics = decodeBase64Url(base64Data)
  return parseIcs(ics)
}

function findCalendarPart(part: GmailMessagePart): GmailMessagePart | null {
  if (part.mimeType === 'text/calendar') {
    return (part.body.data || part.body.attachmentId) ? part : null
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = findCalendarPart(child)
      if (found) return found
    }
  }
  return null
}

function parseIcs(ics: string): CalendarEvent | undefined {
  // Unfold lines (RFC 5545: lines starting with space/tab are continuations)
  const unfolded = ics.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)

  let inEvent = false
  let method: string | undefined
  const props: Record<string, string> = {}
  const attendees: { name?: string; email: string; status: string }[] = []
  let organizer: { name?: string; email: string } | undefined

  for (const line of lines) {
    const [key, ...rest] = line.split(':')
    const value = rest.join(':')

    if (key === 'METHOD') method = value
    if (key === 'BEGIN' && value === 'VEVENT') { inEvent = true; continue }
    if (key === 'END' && value === 'VEVENT') break
    if (!inEvent) continue

    // Handle parameterized keys like ATTENDEE;CN=Name;PARTSTAT=ACCEPTED
    const baseName = key!.split(';')[0]!
    const params = parseIcsParams(key!)

    if (baseName === 'ATTENDEE') {
      const email = value.replace(/^mailto:/i, '')
      attendees.push({
        name: params.CN || undefined,
        email,
        status: (params.PARTSTAT || 'NEEDS-ACTION').toLowerCase(),
      })
    } else if (baseName === 'ORGANIZER') {
      const email = value.replace(/^mailto:/i, '')
      organizer = { name: params.CN || undefined, email }
    } else {
      props[baseName!] = value
    }
  }

  if (!props.DTSTART) return undefined

  return {
    summary: props.SUMMARY || '(no title)',
    location: props.LOCATION || undefined,
    description: props.DESCRIPTION?.replace(/\\n/g, '\n').replace(/\\,/g, ',') || undefined,
    start: parseIcsDate(props.DTSTART),
    end: parseIcsDate(props.DTEND || props.DTSTART),
    organizer,
    attendees: attendees.length > 0 ? attendees : undefined,
    status: props.STATUS || undefined,
    method,
  }
}

function parseIcsParams(key: string): Record<string, string> {
  const params: Record<string, string> = {}
  const parts = key.split(';')
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i]!.indexOf('=')
    if (eq > 0) {
      params[parts[i]!.substring(0, eq)] = parts[i]!.substring(eq + 1).replace(/^"|"$/g, '')
    }
  }
  return params
}

function parseIcsDate(value: string): number {
  // Formats: 20240115T090000Z, 20240115T090000, TZID=...:20240115T090000
  const dateStr = value.includes(':') ? value.split(':').pop()! : value
  const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
  if (!match) {
    // All-day: 20240115
    const dayMatch = dateStr.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (dayMatch) {
      return new Date(+dayMatch[1]!, +dayMatch[2]! - 1, +dayMatch[3]!).getTime()
    }
    return Date.now()
  }
  const [, y, mo, d, h, mi, s, z] = match
  if (z) {
    return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)
  }
  return new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +s!).getTime()
}

export function buildDarkModeEmailCss(): string {
  return `
    :root {
      color-scheme: only light;
    }
    html {
      filter: invert(1) hue-rotate(180deg);
      background: #fff !important;
    }
    img, video, [style*="background-image"], svg {
      filter: invert(1) hue-rotate(180deg);
    }
  `
}

export function encodeBase64Url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface EmailAttachment {
  filename: string
  mimeType: string
  data: string // base64 encoded
}

function encodeHtmlBase64(html: string): string {
  return btoa(unescape(encodeURIComponent(html))).match(/.{1,76}/g)?.join('\n') ?? ''
}

function buildHeaders(opts: {
  from: string
  to: string
  cc?: string
  subject: string
  inReplyTo?: string
  references?: string
  contentType: string
}): string[] {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    opts.cc ? `Cc: ${opts.cc}` : '',
    `Subject: ${opts.subject}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : '',
    opts.references ? `References: ${opts.references}` : '',
    'MIME-Version: 1.0',
    `Content-Type: ${opts.contentType}`,
  ].filter(Boolean)
}

export function buildRawEmail(opts: {
  from: string
  to: string
  cc?: string
  subject: string
  html: string
  inReplyTo?: string
  references?: string
  threadId?: string
  attachments?: EmailAttachment[]
}): string {
  const hasAttachments = opts.attachments && opts.attachments.length > 0

  if (!hasAttachments) {
    const boundary = `boundary_${Date.now()}`
    const lines = [
      ...buildHeaders({ ...opts, contentType: `multipart/alternative; boundary="${boundary}"` }),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodeHtmlBase64(opts.html),
      '',
      `--${boundary}--`,
    ]
    return lines.join('\r\n')
  }

  const boundary = `mixed_${Date.now()}`
  const lines = [
    ...buildHeaders({ ...opts, contentType: `multipart/mixed; boundary="${boundary}"` }),
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
