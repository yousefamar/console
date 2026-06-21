import Dexie, { type Table } from 'dexie'
import type { DbThread, DbMessage, DbAttachmentData, QueuedAction } from '@/gmail/types'
import type { DbChatRoom, DbChatMessage } from '@/matrix/types'
import type { DbCalendarInfo, DbCalendarEvent } from '@/calendar/types'

export interface DbFeedItem {
  id: string
  feedId: string
  title: string
  link: string
  content: string
  contentSnippet: string
  author?: string
  publishedAt: string
  imageUrl?: string
}

export interface DbFeedRead {
  itemId: string
}

/** Client mirror of the hub geocache store (summaries; detail fetched on tap). */
export interface DbGeocache {
  code: string
  name: string
  lat: number | null
  lon: number | null
  type: string
  size: string
  difficulty: number
  terrain: number
  found: boolean
  dnf: boolean
  pmOnly: boolean
  owner: string
  hidden: string
  favorites: number
  status: string
}

class ConsoleDatabase extends Dexie {
  threads!: Table<DbThread, string>
  messages!: Table<DbMessage, string>
  attachmentData!: Table<DbAttachmentData, string>
  chatRooms!: Table<DbChatRoom, string>
  chatMessages!: Table<DbChatMessage, string>
  queue!: Table<QueuedAction, number>
  meta!: Table<{ key: string; value: string }, string>
  feedItems!: Table<DbFeedItem, string>
  feedRead!: Table<DbFeedRead, string>
  calendarList!: Table<DbCalendarInfo, string>
  calendarEvents!: Table<DbCalendarEvent, string>
  geocaches!: Table<DbGeocache, string>

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

    // v4: Add chat tables (Matrix)
    this.version(4).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      attachmentData: 'attachmentId, messageId',
      chatRooms: '&id, lastMessageTime, snoozedUntil',
      chatMessages: '&id, roomId, timestamp, [roomId+timestamp]',
      queue: '++id, type, status, createdAt',
      meta: 'key',
    })

    // v5: Add feed tables
    this.version(5).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      attachmentData: 'attachmentId, messageId',
      chatRooms: '&id, lastMessageTime, snoozedUntil',
      chatMessages: '&id, roomId, timestamp, [roomId+timestamp]',
      queue: '++id, type, status, createdAt',
      meta: 'key',
      feedItems: '&id, feedId, publishedAt, [feedId+publishedAt]',
      feedRead: '&itemId',
    })

    // v6: Add calendar tables
    this.version(6).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      attachmentData: 'attachmentId, messageId',
      chatRooms: '&id, lastMessageTime, snoozedUntil',
      chatMessages: '&id, roomId, timestamp, [roomId+timestamp]',
      queue: '++id, type, status, createdAt',
      meta: 'key',
      feedItems: '&id, feedId, publishedAt, [feedId+publishedAt]',
      feedRead: '&itemId',
      calendarList: '&id',
      calendarEvents: '&compoundKey, calendarId, startTime',
    })

    // v7: Multi-account calendar support — clear old calendar data (compound key format changed)
    this.version(7).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      attachmentData: 'attachmentId, messageId',
      chatRooms: '&id, lastMessageTime, snoozedUntil',
      chatMessages: '&id, roomId, timestamp, [roomId+timestamp]',
      queue: '++id, type, status, createdAt',
      meta: 'key',
      feedItems: '&id, feedId, publishedAt, [feedId+publishedAt]',
      feedRead: '&itemId',
      calendarList: '&id, accountEmail',
      calendarEvents: '&compoundKey, accountEmail, calendarId, startTime',
    }).upgrade((tx) => {
      // Clear old calendar data — compound key format changed from calendarId:eventId to accountEmail:calendarId:eventId
      tx.table('calendarEvents').clear()
      tx.table('calendarList').clear()
    })

    // v8: Map pane — offline basemap archives + geocache mirror
    this.version(8).stores({
      threads: 'id, date, snoozedUntil',
      messages: 'id, threadId, date',
      attachmentData: 'attachmentId, messageId',
      chatRooms: '&id, lastMessageTime, snoozedUntil',
      chatMessages: '&id, roomId, timestamp, [roomId+timestamp]',
      queue: '++id, type, status, createdAt',
      meta: 'key',
      feedItems: '&id, feedId, publishedAt, [feedId+publishedAt]',
      feedRead: '&itemId',
      calendarList: '&id, accountEmail',
      calendarEvents: '&compoundKey, accountEmail, calendarId, startTime',
      basemaps: '&region',
      geocaches: '&code, [lat+lon]',
    })

    // v9: dropped the offline basemap store — the Map pane streams raster tiles
    // on demand now (no self-hosted PMTiles archive).
    this.version(9).stores({
      basemaps: null,
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
