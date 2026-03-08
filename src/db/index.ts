import Dexie, { type Table } from 'dexie'
import type { DbThread, DbMessage, DbAttachmentData, QueuedAction } from '@/gmail/types'

class ConsoleDatabase extends Dexie {
  threads!: Table<DbThread, string>
  messages!: Table<DbMessage, string>
  attachmentData!: Table<DbAttachmentData, string>
  queue!: Table<QueuedAction, number>
  meta!: Table<{ key: string; value: string }, string>

  constructor() {
    super('console-inbox')

    this.version(1).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      drafts: 'id, threadId, updatedAt, scheduledAt',
      queue: '++id, type, status, createdAt',
      meta: 'key',
    })

    this.version(2).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      drafts: 'id, threadId, updatedAt, scheduledAt',
      attachmentData: 'attachmentId, messageId',
      queue: '++id, type, status, createdAt',
      meta: 'key',
    })

    // v3: Remove drafts table
    this.version(3).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      drafts: null,
      attachmentData: 'attachmentId, messageId',
      queue: '++id, type, status, createdAt',
      meta: 'key',
    })
  }
}

export const db = new ConsoleDatabase()

// Meta helpers for storing sync state
export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key)
  return row?.value
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value })
}
