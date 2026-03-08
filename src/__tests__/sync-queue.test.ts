import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db'
import {
  enqueue,
  getPending,
  markProcessing,
  markDone,
  markFailed,
  markConflict,
  removeByThread,
  getQueueCount,
  getConflicts,
} from '@/db/sync-queue'

beforeEach(async () => {
  await db.queue.clear()
})

describe('enqueue', () => {
  it('adds an action to the queue', async () => {
    const id = await enqueue('archive', {}, { threadId: 't1' })
    expect(id).toBeGreaterThan(0)

    const pending = await getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.type).toBe('archive')
    expect(pending[0]!.threadId).toBe('t1')
    expect(pending[0]!.status).toBe('pending')
    expect(pending[0]!.retryCount).toBe(0)
  })

  it('stores payload', async () => {
    await enqueue('send', { to: 'a@b.com', subject: 'Hi' }, { threadId: 't2' })
    const pending = await getPending()
    expect(pending[0]!.payload).toEqual({ to: 'a@b.com', subject: 'Hi' })
  })

  it('stores optional messageId and draftId', async () => {
    await enqueue('send', { html: '<p>hello</p>' }, { threadId: 't3', draftId: 'd1' })
    const pending = await getPending()
    expect(pending[0]!.draftId).toBe('d1')
  })

  it('returns unique IDs for multiple enqueues', async () => {
    const id1 = await enqueue('archive', {}, { threadId: 't1' })
    const id2 = await enqueue('archive', {}, { threadId: 't2' })
    expect(id1).not.toBe(id2)
  })
})

describe('getPending', () => {
  it('returns only pending actions sorted by createdAt', async () => {
    await enqueue('archive', {}, { threadId: 't1' })
    await enqueue('markRead', {}, { threadId: 't2' })

    // Mark first as processing
    const all = await getPending()
    await markProcessing(all[0]!.id!)

    const pending = await getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.type).toBe('markRead')
  })

  it('returns empty array when no pending actions', async () => {
    expect(await getPending()).toEqual([])
  })
})

describe('markProcessing', () => {
  it('changes status to processing', async () => {
    const id = await enqueue('archive', {}, { threadId: 't1' })
    await markProcessing(id)

    const action = await db.queue.get(id)
    expect(action!.status).toBe('processing')
  })
})

describe('markDone', () => {
  it('removes the action from the queue', async () => {
    const id = await enqueue('archive', {}, { threadId: 't1' })
    await markDone(id)

    const action = await db.queue.get(id)
    expect(action).toBeUndefined()
  })
})

describe('markFailed', () => {
  it('sets status back to pending on first failure', async () => {
    const id = await enqueue('send', {}, { threadId: 't1' })
    await markFailed(id, 'Network error')

    const action = await db.queue.get(id)
    expect(action!.status).toBe('pending')
    expect(action!.error).toBe('Network error')
    expect(action!.retryCount).toBe(1)
  })

  it('marks as failed after 3 retries', async () => {
    const id = await enqueue('send', {}, { threadId: 't1' })

    // Simulate 3 failures
    await markFailed(id, 'fail 1')
    await markFailed(id, 'fail 2')
    await markFailed(id, 'fail 3')

    const action = await db.queue.get(id)
    expect(action!.status).toBe('pending') // retryCount=3, but >= check happens next

    await markFailed(id, 'fail 4')
    const final = await db.queue.get(id)
    expect(final!.status).toBe('failed')
    expect(final!.retryCount).toBe(4)
  })

  it('failed actions are not returned by getPending', async () => {
    const id = await enqueue('send', {}, { threadId: 't1' })
    // Force retryCount to 3 so next failure marks it failed
    await db.queue.update(id, { retryCount: 3 })
    await markFailed(id, 'final fail')

    const pending = await getPending()
    expect(pending).toHaveLength(0)
  })
})

describe('markConflict', () => {
  it('sets status to conflict with error', async () => {
    const id = await enqueue('send', {}, { threadId: 't1' })
    await markConflict(id, 'New messages arrived')

    const action = await db.queue.get(id)
    expect(action!.status).toBe('conflict')
    expect(action!.error).toBe('New messages arrived')
  })

  it('conflicts are returned by getConflicts', async () => {
    const id = await enqueue('send', {}, { threadId: 't1' })
    await markConflict(id, 'conflict msg')

    const conflicts = await getConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.id).toBe(id)
  })

  it('conflicts are not returned by getPending', async () => {
    const id = await enqueue('send', {}, { threadId: 't1' })
    await markConflict(id, 'conflict')

    expect(await getPending()).toHaveLength(0)
  })
})

describe('removeByThread', () => {
  it('removes all pending actions for a thread', async () => {
    await enqueue('archive', {}, { threadId: 't1' })
    await enqueue('markRead', {}, { threadId: 't1' })
    await enqueue('archive', {}, { threadId: 't2' })

    await removeByThread('t1')

    const pending = await getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.threadId).toBe('t2')
  })

  it('removes only actions of a specific type', async () => {
    await enqueue('archive', {}, { threadId: 't1' })
    await enqueue('markRead', {}, { threadId: 't1' })

    await removeByThread('t1', 'archive')

    const pending = await getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.type).toBe('markRead')
  })

  it('does not remove processing actions', async () => {
    const id = await enqueue('archive', {}, { threadId: 't1' })
    await markProcessing(id)

    await removeByThread('t1')

    // Processing action should still exist
    const action = await db.queue.get(id)
    expect(action).toBeTruthy()
    expect(action!.status).toBe('processing')
  })
})

describe('getQueueCount', () => {
  it('counts pending and processing actions', async () => {
    const id1 = await enqueue('archive', {}, { threadId: 't1' })
    await enqueue('markRead', {}, { threadId: 't2' })
    await markProcessing(id1)

    expect(await getQueueCount()).toBe(2)
  })

  it('does not count failed or conflict actions', async () => {
    const id1 = await enqueue('send', {}, { threadId: 't1' })
    const id2 = await enqueue('send', {}, { threadId: 't2' })
    await enqueue('archive', {}, { threadId: 't3' })

    await db.queue.update(id1, { retryCount: 3 })
    await markFailed(id1, 'fail')
    await markConflict(id2, 'conflict')

    expect(await getQueueCount()).toBe(1)
  })

  it('returns 0 for empty queue', async () => {
    expect(await getQueueCount()).toBe(0)
  })
})
