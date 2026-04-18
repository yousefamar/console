import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock auth module before importing api
vi.mock('@/gmail/auth', () => ({
  notifyAuthExpired: vi.fn(),
}))

// Mock hub url (api.ts imports getHubUrl)
vi.mock('@/hub', () => ({
  getHubUrl: () => 'https://hub.test',
}))

import { notifyAuthExpired } from '@/gmail/auth'
import {
  getProfile,
  sendEmail,
  getSendAsAliases,
  searchContacts,
  archiveThread,
  trashThread,
  markThreadRead,
  getAttachment,
  listThreads,
} from '@/gmail/api'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  vi.clearAllMocks()
})

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

describe('getProfile', () => {
  it('fetches from hub /mail/profile', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      emailAddress: 'user@gmail.com',
      messagesTotal: 100,
      threadsTotal: 50,
      historyId: '12345',
    }))

    const profile = await getProfile()
    expect(profile.emailAddress).toBe('user@gmail.com')
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('https://hub.test/mail/profile')
    const calledOpts = mockFetch.mock.calls[0]![1] as RequestInit
    expect((calledOpts.headers as Record<string, string>)?.Authorization).toBeUndefined()
  })
})

describe('sendEmail', () => {
  it('POSTs to hub /mail/send with body fields', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 'msg-1', threadId: 't1' }))

    await sendEmail({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      threadId: 'thread-1',
    })

    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/mail/send')
    const opts = mockFetch.mock.calls[0]![1] as RequestInit
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string)
    expect(body).toMatchObject({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      body: '<p>Hi</p>',
      html: true,
      threadId: 'thread-1',
    })
  })
})

describe('getSendAsAliases', () => {
  it('returns aliases from hub (already mapped)', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([
      { email: 'primary@example.com', name: 'Primary', isDefault: true },
      { email: 'alias@example.com', name: 'Alias', isDefault: false },
    ]))

    const aliases = await getSendAsAliases()
    expect(aliases).toHaveLength(2)
    expect(aliases[0]).toEqual({ email: 'primary@example.com', name: 'Primary', isDefault: true })
  })
})

describe('401 handling', () => {
  it('fires notifyAuthExpired on 401 from hub', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Unauthorized' }, 401))
    await expect(getProfile()).rejects.toThrow('Session expired')
    expect(notifyAuthExpired).toHaveBeenCalled()
  })
})

describe('searchContacts', () => {
  it('calls hub /mail/contacts with q param', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse([
      { name: 'John', email: 'john@example.com' },
    ]))

    const results = await searchContacts('john')
    expect(results).toEqual([{ name: 'John', email: 'john@example.com' }])
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/mail/contacts')
    expect(calledUrl).toContain('q=john')
  })

  it('returns empty for empty query without hitting hub', async () => {
    const results = await searchContacts('')
    expect(results).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns empty on error', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'boom' }, 500))
    const results = await searchContacts('john')
    expect(results).toEqual([])
  })
})

describe('archiveThread', () => {
  it('POSTs hub /mail/threads/:id/archive', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    await archiveThread('t1')
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/mail/threads/t1/archive')
    const opts = mockFetch.mock.calls[0]![1] as RequestInit
    expect(opts.method).toBe('POST')
  })
})

describe('trashThread', () => {
  it('POSTs hub /mail/threads/:id/trash', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    await trashThread('t1')
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/mail/threads/t1/trash')
  })
})

describe('markThreadRead', () => {
  it('POSTs hub /mail/threads/:id/read', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    await markThreadRead('t1')
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/mail/threads/t1/read')
  })
})

describe('getAttachment', () => {
  it('returns attachment data from hub', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: 'base64data', size: 1024 }))
    const data = await getAttachment('msg-1', 'att-1')
    expect(data).toBe('base64data')
    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/mail/messages/msg-1/attachments/att-1')
  })
})

describe('listThreads', () => {
  it('passes query params correctly', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      threads: [{ id: 't1', historyId: '100', snippet: 'Hi' }],
      resultSizeEstimate: 1,
    }))

    await listThreads({ maxResults: 10, q: 'is:starred' })

    const calledUrl = mockFetch.mock.calls[0]![0] as string
    expect(calledUrl).toContain('maxResults=10')
    expect(calledUrl).toContain('q=is%3Astarred')
  })
})
