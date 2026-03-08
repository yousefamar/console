import { db } from './index'
import type { QueueActionType, QueuedAction } from '@/gmail/types'

// Listener for immediate queue flush
let flushListener: (() => void) | null = null

export function onEnqueue(fn: () => void): () => void {
  flushListener = fn
  return () => { flushListener = null }
}

export async function enqueue(
  type: QueueActionType,
  payload: Record<string, unknown>,
  opts: { threadId?: string; messageId?: string; draftId?: string } = {},
): Promise<number> {
  const action: QueuedAction = {
    type,
    payload,
    threadId: opts.threadId,
    messageId: opts.messageId,
    draftId: opts.draftId,
    createdAt: Date.now(),
    status: 'pending',
    retryCount: 0,
  }
  const id = await db.queue.add(action)
  flushListener?.()
  return id
}

export async function getPending(): Promise<QueuedAction[]> {
  return db.queue.where('status').equals('pending').sortBy('createdAt')
}

export async function markProcessing(id: number): Promise<void> {
  await db.queue.update(id, { status: 'processing' })
}

export async function markFailed(id: number, error: string): Promise<void> {
  const action = await db.queue.get(id)
  if (!action) return
  await db.queue.update(id, {
    status: action.retryCount >= 3 ? 'failed' : 'pending',
    error,
    retryCount: action.retryCount + 1,
  })
}

export async function markDone(id: number): Promise<void> {
  await db.queue.delete(id)
}

export async function markConflict(id: number, error: string): Promise<void> {
  await db.queue.update(id, { status: 'conflict', error })
}

export async function removeByThread(threadId: string, type?: QueueActionType): Promise<void> {
  let collection = db.queue.where('status').equals('pending').filter(a => a.threadId === threadId)
  if (type) {
    collection = collection.filter(a => a.type === type)
  }
  await collection.delete()
}

export async function getQueueCount(): Promise<number> {
  return db.queue.where('status').anyOf('pending', 'processing').count()
}

export async function getConflicts(): Promise<QueuedAction[]> {
  return db.queue.where('status').equals('conflict').toArray()
}
