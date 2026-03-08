import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock auth module before importing api
vi.mock('@/gmail/auth', () => ({
  getAccessToken: vi.fn(),
  refreshAccessToken: vi.fn(),
  notifyAuthExpired: vi.fn(),
}))

// Mock email utils
vi.mock('@/utils/email', () => ({
  buildRawEmail: vi.fn(() => 'raw-mime-content'),
  encodeBase64Url: vi.fn(() => 'encoded-base64url'),
}))

import { getAccessToken, refreshAccessToken, notifyAuthExpired } from '@/gmail/auth'
import { buildRawEmail, encodeBase64Url } from '@/utils/email'
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
  vi.mocked(getAccessToken).mockResolvedValue('fake-token')
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
  it('fetches profile with auth header', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      emailAddress: 'user@gmail.com',
      messagesTotal: 100,
      threadsTotal: 50,
      historyId: '12345',
    }))

    const profile = await getProfile()
    expect(profile.emailAddress).toBe('user@gmail.com')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/profile'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-token',
        }),
      }),
    )
  })
})

describe('sendEmail', () => {
  it('builds raw email and POSTs to messages/send', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 'msg-1', threadId: 't1' }))

    await sendEmail({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
      threadId: 'thread-1',
    })

    expect(buildRawEmail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    }))
    expect(encodeBase64Url).toHaveBeenCalledWith('raw-mime-content')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/messages/send'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ raw: 'encoded-base64url', threadId: 'thread-1' }),
      }),
    )
  })

  it('omits threadId from body when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 'msg-1' }))

    await sendEmail({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0]![1].body)
    expect(callBody.threadId).toBeUndefined()
  })
})

describe('getSendAsAliases', () => {
  it('parses sendAs response into SendAsAlias array', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      sendAs: [
        { sendAsEmail: 'primary@example.com', displayName: 'Primary', isDefault: true, isPrimary: true },
        { sendAsEmail: 'alias@example.com', displayName: 'Alias', isDefault: false, isPrimary: false },
      ],
    }))

    const aliases = await getSendAsAliases()
    expect(aliases).toHaveLength(2)
    expect(aliases[0]).toEqual({ email: 'primary@example.com', name: 'Primary', isDefault: true })
    expect(aliases[1]).toEqual({ email: 'alias@example.com', name: 'Alias', isDefault: false })
  })

  it('handles empty sendAs', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}))
    const aliases = await getSendAsAliases()
    expect(aliases).toEqual([])
  })

  it('handles missing displayName', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      sendAs: [{ sendAsEmail: 'a@b.com', displayName: '', isPrimary: true }],
    }))
    const aliases = await getSendAsAliases()
    expect(aliases[0]!.name).toBe('')
    expect(aliases[0]!.isDefault).toBe(true) // isPrimary fallback when isDefault is undefined
  })
})

describe('401 handling', () => {
  it('retries with refreshed token on 401', async () => {
    // First call returns 401
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Unauthorized' }, 401))
    // After refresh, retry succeeds
    vi.mocked(refreshAccessToken).mockResolvedValueOnce(true)
    vi.mocked(getAccessToken).mockResolvedValueOnce('refreshed-token')
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      emailAddress: 'user@gmail.com',
      messagesTotal: 100,
      threadsTotal: 50,
      historyId: '12345',
    }))

    const profile = await getProfile()
    expect(profile.emailAddress).toBe('user@gmail.com')
    expect(refreshAccessToken).toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('calls notifyAuthExpired when refresh fails', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Unauthorized' }, 401))
    vi.mocked(refreshAccessToken).mockResolvedValueOnce(false)

    await expect(getProfile()).rejects.toThrow('Session expired')
    expect(notifyAuthExpired).toHaveBeenCalled()
  })

  it('throws when no access token', async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce(null)
    await expect(getProfile()).rejects.toThrow('Session expired')
    expect(notifyAuthExpired).toHaveBeenCalled()
  })
})

describe('searchContacts', () => {
  it('searches both otherContacts and savedContacts', async () => {
    vi.mocked(getAccessToken).mockResolvedValue('fake-token')

    // otherContacts response
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      results: [
        { person: { names: [{ displayName: 'John' }], emailAddresses: [{ value: 'john@example.com' }] } },
      ],
    }))

    // savedContacts response
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      results: [
        { person: { names: [{ displayName: 'Jane' }], emailAddresses: [{ value: 'jane@example.com' }] } },
      ],
    }))

    const results = await searchContacts('j')
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ name: 'John', email: 'john@example.com' })
    expect(results[1]).toEqual({ name: 'Jane', email: 'jane@example.com' })
  })

  it('deduplicates contacts by email', async () => {
    vi.mocked(getAccessToken).mockResolvedValue('fake-token')

    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      results: [
        { person: { names: [{ displayName: 'John' }], emailAddresses: [{ value: 'john@example.com' }] } },
      ],
    }))

    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      results: [
        { person: { names: [{ displayName: 'John Doe' }], emailAddresses: [{ value: 'john@example.com' }] } },
      ],
    }))

    const results = await searchContacts('john')
    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe('John') // keeps otherContacts version
  })

  it('returns empty for empty query', async () => {
    const results = await searchContacts('')
    expect(results).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns empty when no token', async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce(null)
    const results = await searchContacts('test')
    expect(results).toEqual([])
  })

  it('handles missing names gracefully', async () => {
    vi.mocked(getAccessToken).mockResolvedValue('fake-token')

    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      results: [
        { person: { emailAddresses: [{ value: 'noname@example.com' }] } },
      ],
    }))
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ results: [] }))

    const results = await searchContacts('noname')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({ name: '', email: 'noname@example.com' })
  })
})

describe('archiveThread', () => {
  it('POSTs modify with removeLabelIds INBOX', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}))
    await archiveThread('t1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/threads/t1/modify'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      }),
    )
  })
})

describe('trashThread', () => {
  it('POSTs to trash endpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}))
    await trashThread('t1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/threads/t1/trash'),
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('markThreadRead', () => {
  it('POSTs modify with removeLabelIds UNREAD', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({}))
    await markThreadRead('t1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/threads/t1/modify'),
      expect.objectContaining({
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      }),
    )
  })
})

describe('getAttachment', () => {
  it('returns attachment data', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: 'base64data', size: 1024 }))
    const data = await getAttachment('msg-1', 'att-1')
    expect(data).toBe('base64data')
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
