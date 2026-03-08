import { describe, it, expect } from 'vitest'
import {
  parseFrom,
  parseAddressList,
  getHeader,
  getAllHeaders,
  getBodyHtml,
  getBodyText,
  getAttachments,
  encodeBase64Url,
  buildRawEmail,
} from '@/utils/email'
import type { GmailMessage, GmailMessagePart } from '@/gmail/types'

// Helper to build a minimal GmailMessage
function makeMessage(overrides: {
  headers?: { name: string; value: string }[]
  bodyData?: string
  bodyMimeType?: string
  parts?: GmailMessagePart[]
}): GmailMessage {
  const payload: GmailMessagePart = {
    partId: '0',
    mimeType: overrides.bodyMimeType ?? 'text/plain',
    filename: '',
    headers: overrides.headers ?? [],
    body: { size: 0, data: overrides.bodyData },
    parts: overrides.parts,
  }
  return {
    id: 'msg1',
    threadId: 'thread1',
    labelIds: ['INBOX'],
    snippet: '',
    historyId: '1',
    internalDate: '1700000000000',
    payload,
    sizeEstimate: 100,
  }
}

describe('parseFrom', () => {
  it('parses "Name <email>" format', () => {
    expect(parseFrom('John Doe <john@example.com>')).toEqual({
      name: 'John Doe',
      email: 'john@example.com',
    })
  })

  it('strips quotes from name', () => {
    expect(parseFrom('"Jane Doe" <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
    })
  })

  it('handles bare email', () => {
    expect(parseFrom('bare@example.com')).toEqual({
      name: 'bare@example.com',
      email: 'bare@example.com',
    })
  })

  it('handles empty string', () => {
    expect(parseFrom('')).toEqual({ name: '', email: '' })
  })
})

describe('parseAddressList', () => {
  it('parses comma-separated addresses', () => {
    const result = parseAddressList('Alice <a@x.com>, Bob <b@x.com>')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: 'Alice', email: 'a@x.com' })
    expect(result[1]).toEqual({ name: 'Bob', email: 'b@x.com' })
  })

  it('returns empty for empty string', () => {
    expect(parseAddressList('')).toEqual([])
  })

  it('handles single address', () => {
    expect(parseAddressList('solo@example.com')).toEqual([
      { name: 'solo@example.com', email: 'solo@example.com' },
    ])
  })

  it('handles quoted commas in names', () => {
    const result = parseAddressList('"Last, First" <f@x.com>, other@x.com')
    expect(result).toHaveLength(2)
    expect(result[0]!.email).toBe('f@x.com')
  })
})

describe('getHeader / getAllHeaders', () => {
  it('finds a header case-insensitively', () => {
    const msg = makeMessage({
      headers: [
        { name: 'Subject', value: 'Test Subject' },
        { name: 'From', value: 'sender@test.com' },
      ],
    })
    expect(getHeader(msg, 'subject')).toBe('Test Subject')
    expect(getHeader(msg, 'from')).toBe('sender@test.com')
  })

  it('returns empty string for missing header', () => {
    const msg = makeMessage({ headers: [] })
    expect(getHeader(msg, 'X-Missing')).toBe('')
  })

  it('getAllHeaders lowercases keys', () => {
    const msg = makeMessage({
      headers: [
        { name: 'Content-Type', value: 'text/html' },
        { name: 'X-Custom', value: 'foo' },
      ],
    })
    const headers = getAllHeaders(msg)
    expect(headers['content-type']).toBe('text/html')
    expect(headers['x-custom']).toBe('foo')
  })
})

describe('getBodyHtml', () => {
  it('decodes base64url HTML body', () => {
    // base64url encode "<b>Hello</b>"
    const encoded = btoa('<b>Hello</b>').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const msg = makeMessage({
      bodyMimeType: 'text/html',
      bodyData: encoded,
    })
    expect(getBodyHtml(msg)).toBe('<b>Hello</b>')
  })

  it('wraps plain text in pre tag', () => {
    const encoded = btoa('Just text').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const msg = makeMessage({ bodyData: encoded })
    const html = getBodyHtml(msg)
    expect(html).toContain('<pre')
    expect(html).toContain('Just text')
  })

  it('returns "No content" for empty message', () => {
    const msg = makeMessage({})
    msg.payload.body.data = undefined
    expect(getBodyHtml(msg)).toContain('No content')
  })

  it('finds HTML in nested parts', () => {
    const encoded = btoa('<p>Nested</p>').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const msg = makeMessage({
      bodyMimeType: 'multipart/alternative',
      parts: [
        {
          partId: '0',
          mimeType: 'text/plain',
          filename: '',
          headers: [],
          body: { size: 0, data: btoa('plain') },
        },
        {
          partId: '1',
          mimeType: 'text/html',
          filename: '',
          headers: [],
          body: { size: 0, data: encoded },
        },
      ],
    })
    expect(getBodyHtml(msg)).toBe('<p>Nested</p>')
  })
})

describe('getBodyText', () => {
  it('extracts plain text', () => {
    const encoded = btoa('Hello world').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const msg = makeMessage({ bodyData: encoded })
    expect(getBodyText(msg)).toBe('Hello world')
  })

  it('returns empty for no content', () => {
    const msg = makeMessage({})
    msg.payload.body.data = undefined
    expect(getBodyText(msg)).toBe('')
  })
})

describe('getAttachments', () => {
  it('finds attachments with attachmentId', () => {
    const msg = makeMessage({
      bodyMimeType: 'multipart/mixed',
      parts: [
        {
          partId: '0',
          mimeType: 'text/html',
          filename: '',
          headers: [],
          body: { size: 0, data: btoa('body') },
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'doc.pdf',
          headers: [],
          body: { size: 12345, attachmentId: 'att-123' },
        },
      ],
    })
    const atts = getAttachments(msg)
    expect(atts).toHaveLength(1)
    expect(atts[0]).toEqual({
      attachmentId: 'att-123',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 12345,
      contentId: undefined,
    })
  })

  it('extracts Content-ID for inline attachments', () => {
    const msg = makeMessage({
      bodyMimeType: 'multipart/mixed',
      parts: [
        {
          partId: '0',
          mimeType: 'image/png',
          filename: 'inline.png',
          headers: [{ name: 'Content-Id', value: '<abc123>' }],
          body: { size: 500, attachmentId: 'att-inline' },
        },
      ],
    })
    const atts = getAttachments(msg)
    expect(atts).toHaveLength(1)
    expect(atts[0]!.contentId).toBe('abc123')
  })

  it('returns empty for no attachments', () => {
    const msg = makeMessage({})
    expect(getAttachments(msg)).toEqual([])
  })
})

describe('encodeBase64Url', () => {
  it('produces URL-safe base64', () => {
    const result = encodeBase64Url('Hello World')
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
    expect(result).not.toContain('=')
  })

  it('handles unicode', () => {
    const encoded = encodeBase64Url('Héllo Wörld 🌍')
    expect(encoded).toBeTruthy()
  })
})

describe('buildRawEmail', () => {
  it('builds basic email without attachments', () => {
    const raw = buildRawEmail({
      from: 'sender@test.com',
      to: 'recipient@test.com',
      subject: 'Test',
      html: '<p>Hello</p>',
    })
    expect(raw).toContain('From: sender@test.com')
    expect(raw).toContain('To: recipient@test.com')
    expect(raw).toContain('Subject: Test')
    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('text/html')
  })

  it('includes Cc header when provided', () => {
    const raw = buildRawEmail({
      from: 'me@test.com',
      to: 'you@test.com',
      cc: 'them@test.com',
      subject: 'Test',
      html: '<p>Hi</p>',
    })
    expect(raw).toContain('Cc: them@test.com')
  })

  it('includes In-Reply-To and References', () => {
    const raw = buildRawEmail({
      from: 'me@test.com',
      to: 'you@test.com',
      subject: 'Re: Test',
      html: '<p>Reply</p>',
      inReplyTo: '<msg123@mail.com>',
      references: '<msg000@mail.com> <msg123@mail.com>',
    })
    expect(raw).toContain('In-Reply-To: <msg123@mail.com>')
    expect(raw).toContain('References: <msg000@mail.com> <msg123@mail.com>')
  })

  it('builds multipart/mixed with attachments', () => {
    const raw = buildRawEmail({
      from: 'me@test.com',
      to: 'you@test.com',
      subject: 'With file',
      html: '<p>See attached</p>',
      attachments: [
        {
          filename: 'test.pdf',
          mimeType: 'application/pdf',
          data: btoa('fake pdf content'),
        },
      ],
    })
    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('Content-Disposition: attachment; filename="test.pdf"')
    expect(raw).toContain('Content-Type: application/pdf; name="test.pdf"')
  })

  it('handles multiple attachments', () => {
    const raw = buildRawEmail({
      from: 'me@test.com',
      to: 'you@test.com',
      subject: 'Files',
      html: '<p>Files</p>',
      attachments: [
        { filename: 'a.pdf', mimeType: 'application/pdf', data: btoa('a') },
        { filename: 'b.png', mimeType: 'image/png', data: btoa('b') },
      ],
    })
    expect(raw).toContain('filename="a.pdf"')
    expect(raw).toContain('filename="b.png"')
  })
})

// Note: sanitizeHtml tests require a DOM environment (DOMPurify).
// These would need jsdom or happy-dom — skipped for pure Node test runs.
