import { describe, it, expect, vi } from 'vitest'

// Must be hoisted so localStorage exists when auth.ts module-level code runs
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
})

// Mock out browser-only modules in the import chain
vi.mock('@/gmail/auth', () => ({
  getAccessToken: vi.fn(() => Promise.resolve(null)),
  refreshAccessToken: vi.fn(() => Promise.resolve(false)),
  notifyAuthExpired: vi.fn(),
}))

vi.mock('@/utils/attachment-cache', () => ({
  getAttachmentBlob: vi.fn(() => Promise.resolve(null)),
  formatFileSize: vi.fn(() => '0 B'),
}))

import { pickFromAddress } from '@/components/ComposeEditor'
import type { SendAsAlias, DbMessage } from '@/gmail/types'

function makeAlias(email: string, isDefault = false): SendAsAlias {
  return { email, name: '', isDefault }
}

function makeMessage(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    snippet: 'test',
    from: 'Sender',
    fromEmail: 'sender@example.com',
    to: 'me@example.com',
    cc: '',
    date: Date.now(),
    subject: 'Test',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    historyId: '1000',
    isUnread: false,
    headers: {},
    ...overrides,
  }
}

describe('pickFromAddress', () => {
  it('returns userEmail when no aliases', () => {
    const result = pickFromAddress([], makeMessage(), 'user@gmail.com')
    expect(result).toBe('user@gmail.com')
  })

  it('returns default alias when no lastMessage', () => {
    const aliases = [
      makeAlias('alias@example.com'),
      makeAlias('default@example.com', true),
    ]
    const result = pickFromAddress(aliases, null, 'user@gmail.com')
    expect(result).toBe('default@example.com')
  })

  it('returns first alias when no lastMessage and no default', () => {
    const aliases = [
      makeAlias('first@example.com'),
      makeAlias('second@example.com'),
    ]
    const result = pickFromAddress(aliases, null, 'user@gmail.com')
    expect(result).toBe('first@example.com')
  })

  it('returns exact match when alias email is in To', () => {
    const aliases = [
      makeAlias('work@company.com', true),
      makeAlias('personal@gmail.com'),
    ]
    const msg = makeMessage({ to: 'personal@gmail.com, other@example.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    expect(result).toBe('personal@gmail.com')
  })

  it('returns exact match when alias email is in Cc', () => {
    const aliases = [
      makeAlias('work@company.com', true),
      makeAlias('personal@gmail.com'),
    ]
    const msg = makeMessage({ to: 'other@example.com', cc: 'personal@gmail.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    expect(result).toBe('personal@gmail.com')
  })

  it('is case-insensitive for exact match', () => {
    const aliases = [
      makeAlias('Work@Company.com', true),
      makeAlias('Personal@Gmail.com'),
    ]
    const msg = makeMessage({ to: 'personal@gmail.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    // The function lowercases alias emails for comparison and returns the lowercased version
    expect(result).toBe('personal@gmail.com')
  })

  it('falls back to domain match', () => {
    const aliases = [
      makeAlias('me@company.com', true),
      makeAlias('me@otherdomain.com'),
    ]
    const msg = makeMessage({ to: 'team@otherdomain.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    expect(result).toBe('me@otherdomain.com')
  })

  it('falls back to default alias when no match', () => {
    const aliases = [
      makeAlias('first@example.com'),
      makeAlias('default@company.com', true),
    ]
    const msg = makeMessage({ to: 'someone@unrelated.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    expect(result).toBe('default@company.com')
  })

  it('falls back to first alias when no match and no default', () => {
    const aliases = [
      makeAlias('first@example.com'),
      makeAlias('second@company.com'),
    ]
    const msg = makeMessage({ to: 'someone@unrelated.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    expect(result).toBe('first@example.com')
  })

  it('prefers exact match over domain match', () => {
    const aliases = [
      makeAlias('domain@company.com', true),
      makeAlias('exact@personal.com'),
    ]
    // The message was sent TO exact@personal.com and also to someone@company.com
    const msg = makeMessage({ to: 'exact@personal.com, other@company.com' })
    const result = pickFromAddress(aliases, msg, 'user@gmail.com')
    expect(result).toBe('exact@personal.com')
  })
})
