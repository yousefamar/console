import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '@/db'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'
import type { DbThread, DbMessage } from '@/gmail/types'

// Mock evictThreadAttachments (browser-only module)
vi.mock('@/utils/attachment-cache', () => ({
  evictThreadAttachments: vi.fn(),
}))

// Mock document for UI store dark mode
vi.stubGlobal('document', {
  documentElement: {
    classList: { toggle: vi.fn() },
  },
})

function makeThread(id: string, overrides: Partial<DbThread> = {}): DbThread {
  return {
    id,
    historyId: '1000',
    snippet: `Snippet for ${id}`,
    subject: `Subject ${id}`,
    from: 'Sender',
    fromEmail: 'sender@example.com',
    date: Date.now(),
    messageCount: 1,
    isUnread: false,
    labelIds: ['INBOX'],
    hasAttachments: false,
    ...overrides,
  }
}

function makeMessage(id: string, threadId: string, overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id,
    threadId,
    labelIds: ['INBOX'],
    snippet: `Snippet ${id}`,
    from: 'Sender',
    fromEmail: 'sender@example.com',
    to: 'me@example.com',
    cc: '',
    date: Date.now(),
    subject: `Subject ${threadId}`,
    bodyHtml: '<p>body</p>',
    bodyText: 'body',
    historyId: '1000',
    isUnread: false,
    headers: {},
    ...overrides,
  }
}

beforeEach(async () => {
  await db.threads.clear()
  await db.messages.clear()
  await db.queue.clear()
  useInboxStore.setState({
    threads: [],
    selectedThreadId: null,
    selectedMessages: [],
    replyMode: null,
    replyToMessage: null,
    isLoadingThreads: false,
  })
  useUiStore.setState({
    undoAction: null,
    showSnoozePicker: false,
  })
})

describe('setThreads', () => {
  it('sets the threads list', () => {
    const threads = [makeThread('t1'), makeThread('t2')]
    useInboxStore.getState().setThreads(threads)
    expect(useInboxStore.getState().threads).toHaveLength(2)
  })
})

describe('selectThread', () => {
  it('sets selectedThreadId and loads messages', async () => {
    const thread = makeThread('t1')
    const msg = makeMessage('m1', 't1')
    await db.threads.put(thread)
    await db.messages.put(msg)
    useInboxStore.getState().setThreads([thread])

    await useInboxStore.getState().selectThread('t1')
    expect(useInboxStore.getState().selectedThreadId).toBe('t1')
    expect(useInboxStore.getState().selectedMessages).toHaveLength(1)
    expect(useInboxStore.getState().selectedMessages[0]!.id).toBe('m1')
  })

  it('clears replyMode on select', async () => {
    useInboxStore.setState({ replyMode: 'reply' })
    await useInboxStore.getState().selectThread(null)
    expect(useInboxStore.getState().replyMode).toBeNull()
  })

  it('clears messages when selecting null', async () => {
    useInboxStore.setState({ selectedMessages: [makeMessage('m1', 't1')] })
    await useInboxStore.getState().selectThread(null)
    expect(useInboxStore.getState().selectedMessages).toEqual([])
  })

  it('auto-marks unread threads as read', async () => {
    const thread = makeThread('t1', { isUnread: true })
    const msg = makeMessage('m1', 't1')
    await db.threads.put(thread)
    await db.messages.put(msg)
    useInboxStore.getState().setThreads([thread])

    await useInboxStore.getState().selectThread('t1')

    // Thread in DB should be marked read
    const updated = await db.threads.get('t1')
    expect(updated!.isUnread).toBe(false)

    // Queue should have a markRead action
    const queued = await db.queue.toArray()
    expect(queued.some((q) => q.type === 'markRead')).toBe(true)
  })
})

describe('selectNextThread / selectPrevThread', () => {
  it('selectNextThread selects first thread when none selected', async () => {
    const threads = [makeThread('t1'), makeThread('t2')]
    await db.threads.bulkPut(threads)
    await db.messages.put(makeMessage('m1', 't1'))
    useInboxStore.getState().setThreads(threads)

    await useInboxStore.getState().selectNextThread()
    expect(useInboxStore.getState().selectedThreadId).toBe('t1')
  })

  it('selectNextThread moves to next thread', async () => {
    const threads = [makeThread('t1'), makeThread('t2'), makeThread('t3')]
    await db.threads.bulkPut(threads)
    await db.messages.put(makeMessage('m1', 't1'))
    await db.messages.put(makeMessage('m2', 't2'))
    useInboxStore.setState({ threads, selectedThreadId: 't1' })

    await useInboxStore.getState().selectNextThread()
    expect(useInboxStore.getState().selectedThreadId).toBe('t2')
  })

  it('selectNextThread does nothing at the end', async () => {
    const threads = [makeThread('t1'), makeThread('t2')]
    await db.threads.bulkPut(threads)
    useInboxStore.setState({ threads, selectedThreadId: 't2' })

    await useInboxStore.getState().selectNextThread()
    expect(useInboxStore.getState().selectedThreadId).toBe('t2')
  })

  it('selectPrevThread selects last thread when none selected', async () => {
    const threads = [makeThread('t1'), makeThread('t2')]
    await db.threads.bulkPut(threads)
    await db.messages.put(makeMessage('m2', 't2'))
    useInboxStore.getState().setThreads(threads)

    await useInboxStore.getState().selectPrevThread()
    expect(useInboxStore.getState().selectedThreadId).toBe('t2')
  })

  it('selectPrevThread moves to previous thread', async () => {
    const threads = [makeThread('t1'), makeThread('t2'), makeThread('t3')]
    await db.threads.bulkPut(threads)
    await db.messages.put(makeMessage('m1', 't1'))
    useInboxStore.setState({ threads, selectedThreadId: 't2' })

    await useInboxStore.getState().selectPrevThread()
    expect(useInboxStore.getState().selectedThreadId).toBe('t1')
  })

  it('selectPrevThread does nothing at the beginning', async () => {
    const threads = [makeThread('t1'), makeThread('t2')]
    await db.threads.bulkPut(threads)
    useInboxStore.setState({ threads, selectedThreadId: 't1' })

    await useInboxStore.getState().selectPrevThread()
    expect(useInboxStore.getState().selectedThreadId).toBe('t1')
  })

  it('does nothing with empty threads', async () => {
    useInboxStore.getState().setThreads([])
    useInboxStore.getState().selectNextThread()
    expect(useInboxStore.getState().selectedThreadId).toBeNull()
    useInboxStore.getState().selectPrevThread()
    expect(useInboxStore.getState().selectedThreadId).toBeNull()
  })
})

describe('archiveThread', () => {
  it('removes thread from list and DB, enqueues archive, auto-selects next', async () => {
    const t1 = makeThread('t1')
    const t2 = makeThread('t2')
    await db.threads.bulkPut([t1, t2])
    await db.messages.put(makeMessage('m1', 't1'))
    await db.messages.put(makeMessage('m2', 't2'))
    useInboxStore.setState({ threads: [t1, t2], selectedThreadId: 't1' })

    await useInboxStore.getState().archiveThread('t1')

    // Thread removed from state
    expect(useInboxStore.getState().threads).toHaveLength(1)
    expect(useInboxStore.getState().threads[0]!.id).toBe('t2')

    // Auto-selected next thread
    expect(useInboxStore.getState().selectedThreadId).toBe('t2')

    // Removed from DB
    expect(await db.threads.get('t1')).toBeUndefined()

    // Queue has archive action
    const queued = await db.queue.toArray()
    expect(queued.some((q) => q.type === 'archive' && q.threadId === 't1')).toBe(true)

    // Undo action set
    expect(useUiStore.getState().undoAction).not.toBeNull()
    expect(useUiStore.getState().undoAction!.label).toBe('Archived')
  })

  it('uses selectedThreadId when no threadId provided', async () => {
    const t1 = makeThread('t1')
    await db.threads.put(t1)
    await db.messages.put(makeMessage('m1', 't1'))
    useInboxStore.setState({ threads: [t1], selectedThreadId: 't1' })

    await useInboxStore.getState().archiveThread()

    expect(useInboxStore.getState().threads).toHaveLength(0)
    expect(useInboxStore.getState().selectedThreadId).toBeNull()
  })

  it('does nothing when no thread id', async () => {
    useInboxStore.setState({ selectedThreadId: null })
    await useInboxStore.getState().archiveThread()
    expect(await db.queue.count()).toBe(0)
  })
})

describe('deleteThread', () => {
  it('removes thread and messages from DB, enqueues trash', async () => {
    const t1 = makeThread('t1')
    await db.threads.put(t1)
    await db.messages.put(makeMessage('m1', 't1'))
    useInboxStore.setState({ threads: [t1], selectedThreadId: 't1' })

    await useInboxStore.getState().deleteThread('t1')

    expect(await db.threads.get('t1')).toBeUndefined()
    expect(await db.messages.where('threadId').equals('t1').count()).toBe(0)

    const queued = await db.queue.toArray()
    expect(queued.some((q) => q.type === 'trash' && q.threadId === 't1')).toBe(true)

    expect(useUiStore.getState().undoAction!.label).toBe('Deleted')
  })
})

describe('snoozeThread', () => {
  it('removes from list, updates DB with snoozedUntil, enqueues snooze', async () => {
    const t1 = makeThread('t1')
    const t2 = makeThread('t2')
    await db.threads.bulkPut([t1, t2])
    await db.messages.put(makeMessage('m1', 't1'))
    await db.messages.put(makeMessage('m2', 't2'))
    useInboxStore.setState({ threads: [t1, t2], selectedThreadId: 't1' })

    await useInboxStore.getState().snoozeThread('tomorrow')

    // Removed from visible threads
    expect(useInboxStore.getState().threads).toHaveLength(1)
    expect(useInboxStore.getState().threads[0]!.id).toBe('t2')

    // Thread in DB has snoozedUntil
    const updated = await db.threads.get('t1')
    expect(updated!.snoozedUntil).toBeTruthy()
    expect(updated!.snoozedUntil!).toBeGreaterThan(Date.now())

    // Queue has snooze action
    const queued = await db.queue.toArray()
    expect(queued.some((q) => q.type === 'snooze')).toBe(true)

    // Snooze picker closed
    expect(useUiStore.getState().showSnoozePicker).toBe(false)
  })
})

describe('markRead', () => {
  it('updates thread in DB and state, enqueues markRead', async () => {
    const t1 = makeThread('t1', { isUnread: true })
    await db.threads.put(t1)
    useInboxStore.setState({ threads: [t1], selectedThreadId: 't1' })

    await useInboxStore.getState().markRead('t1')

    // State updated
    expect(useInboxStore.getState().threads[0]!.isUnread).toBe(false)

    // DB updated
    const updated = await db.threads.get('t1')
    expect(updated!.isUnread).toBe(false)

    // Queue
    const queued = await db.queue.toArray()
    expect(queued.some((q) => q.type === 'markRead' && q.threadId === 't1')).toBe(true)
  })
})

describe('setReplyMode', () => {
  it('sets reply mode and message', () => {
    const msg = makeMessage('m1', 't1')
    useInboxStore.getState().setReplyMode('reply', msg)
    expect(useInboxStore.getState().replyMode).toBe('reply')
    expect(useInboxStore.getState().replyToMessage).toEqual(msg)
  })

  it('sets null message when not provided', () => {
    useInboxStore.getState().setReplyMode('forward')
    expect(useInboxStore.getState().replyMode).toBe('forward')
    expect(useInboxStore.getState().replyToMessage).toBeNull()
  })

  it('clears reply mode', () => {
    useInboxStore.getState().setReplyMode('reply')
    useInboxStore.getState().setReplyMode(null)
    expect(useInboxStore.getState().replyMode).toBeNull()
  })
})

describe('sendReply', () => {
  it('enqueues send action, clears replyMode, and archives thread', async () => {
    const t1 = makeThread('t1')
    const t2 = makeThread('t2')
    await db.threads.bulkPut([t1, t2])
    await db.messages.put(makeMessage('m1', 't1'))
    await db.messages.put(makeMessage('m2', 't2'))
    useInboxStore.setState({ threads: [t1, t2], selectedThreadId: 't1', replyMode: 'reply' })

    await useInboxStore.getState().sendReply({
      from: 'me@example.com',
      html: '<p>reply</p>',
      to: 'sender@example.com',
      subject: 'Re: Subject',
    })

    // Reply mode cleared
    expect(useInboxStore.getState().replyMode).toBeNull()

    // Thread archived (removed from list)
    expect(useInboxStore.getState().threads.find((t) => t.id === 't1')).toBeUndefined()

    // Queue has both send and archive
    const queued = await db.queue.toArray()
    expect(queued.some((q) => q.type === 'send')).toBe(true)
    expect(queued.some((q) => q.type === 'archive')).toBe(true)
  })

  it('does nothing when no thread selected', async () => {
    useInboxStore.setState({ selectedThreadId: null })
    await useInboxStore.getState().sendReply({
      html: '<p>test</p>',
      to: 'x@x.com',
      subject: 'Test',
    })
    expect(await db.queue.count()).toBe(0)
  })
})

describe('undoArchive', () => {
  it('restores thread and messages, removes archive from queue, enqueues unarchive', async () => {
    const t1 = makeThread('t1')
    const msg = makeMessage('m1', 't1')

    // Simulate archived state: thread is not in DB
    await db.queue.add({
      type: 'archive',
      threadId: 't1',
      payload: {},
      createdAt: Date.now(),
      status: 'pending',
      retryCount: 0,
    })

    await useInboxStore.getState().undoArchive(t1, [msg])

    // Thread and message restored in DB
    expect(await db.threads.get('t1')).toBeTruthy()
    expect(await db.messages.get('m1')).toBeTruthy()

    // Archive action removed, unarchive added
    const queued = await db.queue.toArray()
    expect(queued.every((q) => q.type !== 'archive')).toBe(true)
    expect(queued.some((q) => q.type === 'unarchive')).toBe(true)

    // Undo action cleared
    expect(useUiStore.getState().undoAction).toBeNull()
  })
})

describe('undoDelete', () => {
  it('restores thread and messages, removes trash from queue', async () => {
    const t1 = makeThread('t1')
    const msg = makeMessage('m1', 't1')

    await db.queue.add({
      type: 'trash',
      threadId: 't1',
      payload: {},
      createdAt: Date.now(),
      status: 'pending',
      retryCount: 0,
    })

    await useInboxStore.getState().undoDelete(t1, [msg])

    expect(await db.threads.get('t1')).toBeTruthy()
    expect(await db.messages.get('m1')).toBeTruthy()

    const queued = await db.queue.toArray()
    expect(queued.every((q) => q.type !== 'trash')).toBe(true)

    expect(useUiStore.getState().undoAction).toBeNull()
  })
})
