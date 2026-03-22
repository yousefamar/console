import { db, getMeta, setMeta } from '@/db'
import * as queue from '@/db/sync-queue'
import { onEnqueue } from '@/db/sync-queue'
import * as api from './api'
import type { DbThread, DbMessage } from './types'
import { getHeader, getBodyHtml, getBodyText, parseFrom, getAllHeaders, getAttachments, getCalendarPart, parseCalendarData } from '@/utils/email'
import { getAccessToken } from './auth'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

type SyncListener = (status: SyncStatus, detail?: string) => void

let listeners: SyncListener[] = []
let currentStatus: SyncStatus = 'idle'
let syncTimer: ReturnType<typeof setInterval> | null = null

export function onSyncStatus(fn: SyncListener): () => void {
  listeners.push(fn)
  fn(currentStatus)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

function setStatus(status: SyncStatus, detail?: string) {
  currentStatus = status
  for (const fn of listeners) fn(status, detail)
}

function isNetworkError(message: string): boolean {
  return message === 'Failed to fetch' || message === 'Load failed' || message === 'NetworkError when attempting to fetch resource.'
}

function gmailMessageToDbThread(thread: Awaited<ReturnType<typeof api.getThread>>): DbThread {
  const allMessages = thread.messages
  const messages = allMessages.filter((m) => !m.labelIds?.includes('DRAFT'))
  // Fall back to all messages if thread only contains drafts
  const effective = messages.length > 0 ? messages : allMessages
  const latest = effective[effective.length - 1]!
  const first = effective[0]!
  const from = parseFrom(getHeader(first, 'From'))

  const hasAttachments = messages.some((msg) => {
    const atts = getAttachments(msg)
    return atts.some((a) => !a.contentId) // non-inline attachments
  })

  return {
    id: thread.id,
    historyId: thread.historyId,
    snippet: latest.snippet,
    subject: getHeader(first, 'Subject') || '(no subject)',
    from: from.name,
    fromEmail: from.email,
    date: parseInt(latest.internalDate),
    messageCount: messages.length || allMessages.length,
    isUnread: latest.labelIds?.includes('UNREAD') ?? false,
    labelIds: [...new Set(allMessages.flatMap((m) => m.labelIds ?? []))],
    hasAttachments,
  }
}

async function gmailMessageToDbMessage(msg: Awaited<ReturnType<typeof api.getMessage>>): Promise<DbMessage> {
  const from = parseFrom(getHeader(msg, 'From'))
  const attachments = getAttachments(msg)

  let calendarEvent: DbMessage['calendarEvent'] = undefined
  const calPart = getCalendarPart(msg)
  if (calPart) {
    try {
      let data = calPart.data
      if (!data && calPart.attachmentId) {
        data = await api.getAttachment(calPart.messageId, calPart.attachmentId)
      }
      if (data) calendarEvent = parseCalendarData(data)
    } catch { /* skip calendar parse errors */ }
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet,
    from: from.name,
    fromEmail: from.email,
    to: getHeader(msg, 'To'),
    cc: getHeader(msg, 'Cc'),
    date: parseInt(msg.internalDate),
    subject: getHeader(msg, 'Subject') || '(no subject)',
    bodyHtml: getBodyHtml(msg),
    bodyText: getBodyText(msg),
    historyId: msg.historyId,
    isUnread: msg.labelIds?.includes('UNREAD') ?? false,
    headers: getAllHeaders(msg),
    attachments: attachments.length > 0 ? attachments : undefined,
    calendarEvent,
  }
}

// Full sync: fetch all inbox threads
export async function fullSync(): Promise<void> {
  setStatus('syncing', 'Full sync...')

  try {
    const profile = await api.getProfile()
    await setMeta('email', profile.emailAddress)

    // Fetch send-as aliases + user labels in parallel
    const [aliasResult, labelResult] = await Promise.allSettled([
      api.getSendAsAliases(),
      api.getLabels(),
    ])
    if (aliasResult.status === 'fulfilled') {
      await setMeta('sendAsAliases', JSON.stringify(aliasResult.value))
    }
    if (labelResult.status === 'fulfilled') {
      const labelMap: Record<string, string> = {}
      for (const l of labelResult.value) labelMap[l.id] = l.name
      await setMeta('labelMap', JSON.stringify(labelMap))
    }

    // Helper: fetch thread data and save to DB
    async function fetchAndSaveThreads(ids: string[]) {
      const threads = await Promise.all(ids.map((id) => api.getThread(id)))
      const threadData: { dbThread: DbThread; dbMessages: DbMessage[] }[] = []
      for (const thread of threads) {
        const dbThread = gmailMessageToDbThread(thread)
        const dbMessages: DbMessage[] = []
        for (const msg of thread.messages) {
          if (msg.labelIds?.includes('DRAFT')) continue
          dbMessages.push(await gmailMessageToDbMessage(msg))
        }
        threadData.push({ dbThread, dbMessages })
      }
      await db.transaction('rw', db.threads, db.messages, async () => {
        for (const { dbThread, dbMessages } of threadData) {
          const existing = await db.threads.get(dbThread.id)
          if (existing?.snoozedUntil) {
            dbThread.snoozedUntil = existing.snoozedUntil
          }
          await db.threads.put(dbThread)
          for (const dbMsg of dbMessages) {
            await db.messages.put(dbMsg)
          }
        }
      })
    }

    // Fetch first page of thread IDs
    const firstPage = await api.listThreads({ maxResults: 100 })
    const allThreadIds: string[] = firstPage.threads?.map((t) => t.id) ?? []

    // Priority: load first 3 threads immediately so user can start reading
    if (allThreadIds.length > 0) {
      const priorityIds = allThreadIds.slice(0, 3)
      await fetchAndSaveThreads(priorityIds)
      setStatus('syncing', `Synced ${priorityIds.length}/${allThreadIds.length}+ threads`)
    }

    // Fetch remaining thread IDs (if paginated)
    let pageToken = firstPage.nextPageToken
    while (pageToken) {
      const result = await api.listThreads({ maxResults: 100, pageToken })
      if (result.threads) {
        allThreadIds.push(...result.threads.map((t) => t.id))
      }
      pageToken = result.nextPageToken
    }

    // Fetch remaining thread data in batches of 10 (skip priority threads)
    const BATCH_SIZE = 10
    for (let i = 3; i < allThreadIds.length; i += BATCH_SIZE) {
      const batch = allThreadIds.slice(i, i + BATCH_SIZE)
      await fetchAndSaveThreads(batch)
      setStatus('syncing', `Synced ${Math.min(i + BATCH_SIZE, allThreadIds.length)}/${allThreadIds.length} threads`)
    }

    // Remove threads no longer in inbox (but preserve snoozed threads)
    const localThreadIds = await db.threads.toCollection().primaryKeys()
    const removedIds = localThreadIds.filter((id) => !allThreadIds.includes(id))
    if (removedIds.length > 0) {
      const snoozedIds = new Set(
        (await db.threads.where('snoozedUntil').above(0).primaryKeys()),
      )
      const idsToDelete = removedIds.filter((id) => !snoozedIds.has(id))
      if (idsToDelete.length > 0) {
        await db.transaction('rw', db.threads, db.messages, async () => {
          await db.threads.bulkDelete(idsToDelete)
          for (const id of idsToDelete) {
            await db.messages.where('threadId').equals(id).delete()
          }
        })
      }
    }

    // Save history ID for incremental sync
    const latestProfile = await api.getProfile()
    await setMeta('historyId', latestProfile.historyId)
    await setMeta('lastSync', String(Date.now()))

    setStatus('idle')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    setStatus(isNetworkError(message) ? 'offline' : 'error', message)
    throw err
  }
}

// Incremental sync using history API
export async function incrementalSync(): Promise<void> {
  const historyId = await getMeta('historyId')
  if (!historyId) {
    return fullSync()
  }

  setStatus('syncing', 'Checking for updates...')

  try {
    let allHistory: Awaited<ReturnType<typeof api.listHistory>>['history'] = []
    let newHistoryId = historyId
    let pageToken: string | undefined

    try {
      do {
        const result = await api.listHistory(historyId, pageToken)
        if (result.history) {
          allHistory = allHistory.concat(result.history)
        }
        newHistoryId = result.historyId
        pageToken = result.nextPageToken
      } while (pageToken)
    } catch (err) {
      // History ID expired or invalid, do a full sync
      if (err instanceof Error && (err.message.includes('404') || err.message.includes('400'))) {
        return fullSync()
      }
      throw err
    }

    if (allHistory.length === 0) {
      setStatus('idle')
      return
    }

    // Collect affected thread IDs
    const affectedThreadIds = new Set<string>()
    const deletedMessageIds = new Set<string>()

    for (const record of allHistory) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          affectedThreadIds.add(added.message.threadId)
        }
      }
      if (record.messagesDeleted) {
        for (const deleted of record.messagesDeleted) {
          affectedThreadIds.add(deleted.message.threadId)
          deletedMessageIds.add(deleted.message.id)
        }
      }
      if (record.labelsAdded) {
        for (const labeled of record.labelsAdded) {
          affectedThreadIds.add(labeled.message.threadId)
        }
      }
      if (record.labelsRemoved) {
        for (const unlabeled of record.labelsRemoved) {
          affectedThreadIds.add(unlabeled.message.threadId)
        }
      }
    }

    // Check for pending queue actions to avoid race conditions
    const pendingActions = await queue.getPending()
    const pendingThreadIds = new Set(
      pendingActions
        .filter((a) => a.type === 'unarchive' || a.type === 'unsnooze')
        .map((a) => a.threadId)
        .filter(Boolean),
    )

    // Re-fetch affected threads
    for (const threadId of affectedThreadIds) {
      try {
        const thread = await api.getThread(threadId)
        const isInInbox = thread.messages.some((m) => m.labelIds?.includes('INBOX'))

        if (isInInbox) {
          const dbThread = gmailMessageToDbThread(thread)
          // Convert messages outside transaction (gmailMessageToDbMessage may fetch attachments)
          const dbMessages: DbMessage[] = []
          for (const msg of thread.messages) {
            if (msg.labelIds?.includes('DRAFT')) continue
            dbMessages.push(await gmailMessageToDbMessage(msg))
          }
          // Preserve snoozedUntil from existing record (may be set locally)
          const existing = await db.threads.get(threadId)
          if (existing?.snoozedUntil) {
            dbThread.snoozedUntil = existing.snoozedUntil
          }
          await db.threads.put(dbThread)
          for (const dbMsg of dbMessages) {
            await db.messages.put(dbMsg)
          }
        } else if (!pendingThreadIds.has(threadId)) {
          // Thread no longer in inbox and no pending unarchive — check if snoozed before removing
          const existing = await db.threads.get(threadId)
          if (!existing?.snoozedUntil) {
            await db.threads.delete(threadId)
            await db.messages.where('threadId').equals(threadId).delete()
          }
        }
      } catch {
        if (!pendingThreadIds.has(threadId)) {
          const existing = await db.threads.get(threadId)
          if (!existing?.snoozedUntil) {
            await db.threads.delete(threadId)
            await db.messages.where('threadId').equals(threadId).delete()
          }
        }
      }
    }

    // Clean up deleted messages
    if (deletedMessageIds.size > 0) {
      await db.messages.bulkDelete([...deletedMessageIds])
    }

    await setMeta('historyId', newHistoryId)
    await setMeta('lastSync', String(Date.now()))

    setStatus('idle')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    setStatus(isNetworkError(message) ? 'offline' : 'error', message)
    throw err
  }
}

// Process the offline queue (email actions only — chat actions handled by matrix/sync.ts)
export async function processQueue(): Promise<void> {
  const token = await getAccessToken()
  if (!token) return // Offline

  const pending = await queue.getPending()
  if (pending.length === 0) return

  for (const action of pending) {
    if (!action.id) continue
    // Skip chat actions — handled by processChatQueue
    if (action.type.startsWith('chat')) continue
    await queue.markProcessing(action.id)

    try {
      switch (action.type) {
        case 'archive':
          await api.archiveThread(action.threadId!)
          break
        case 'unarchive':
          await api.unarchiveThread(action.threadId!)
          break
        case 'trash':
          await api.trashThread(action.threadId!)
          break
        case 'markRead':
          await api.markThreadRead(action.threadId!)
          break
        case 'markUnread':
          await api.markThreadUnread(action.threadId!)
          break
        case 'send': {
          const p = action.payload as {
            from?: string
            to: string
            cc?: string
            subject: string
            html: string
            inReplyTo?: string
            references?: string
            threadId?: string
            attachments?: { filename: string; mimeType: string; data: string }[]
          }
          // Check for conflicts: if there are new messages in the thread
          if (p.threadId) {
            try {
              const thread = await api.getThread(p.threadId)
              const localMessages = await db.messages
                .where('threadId')
                .equals(p.threadId)
                .count()
              if (thread.messages.length > localMessages) {
                await queue.markConflict(
                  action.id,
                  'New messages arrived in this thread. Please review before sending.',
                )
                continue
              }
            } catch {
              // Thread fetch failed, try sending anyway
            }
          }
          const from = p.from || await getMeta('email') || 'me'
          await api.sendEmail({ ...p, from })
          break
        }
        case 'snooze': {
          // Archive the thread (remove from inbox)
          await api.archiveThread(action.threadId!)
          break
        }
        case 'unsnooze': {
          // Move back to inbox
          await api.unarchiveThread(action.threadId!)
          break
        }
      }
      await queue.markDone(action.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      await queue.markFailed(action.id, message)
    }
  }
}

// Check for snoozed threads that should reappear
export async function checkSnoozes(): Promise<void> {
  const now = Date.now()
  const snoozedThreads = await db.threads
    .where('snoozedUntil')
    .belowOrEqual(now)
    .toArray()

  for (const thread of snoozedThreads) {
    if (!thread.snoozedUntil) continue
    // Unsnooze: add back INBOX label
    await db.threads.update(thread.id, {
      snoozedUntil: undefined,
      labelIds: [...thread.labelIds, 'INBOX'],
    })
    await queue.enqueue('unsnooze', {}, { threadId: thread.id })
  }
}

// Flush queue immediately (debounced to coalesce rapid actions)
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushUnsub: (() => void) | null = null

async function flushQueue(): Promise<void> {
  try {
    await processQueue()
  } catch {
    // Errors already reported via status
  }
}

// Start periodic sync
export function startSyncLoop(intervalMs = 30_000): void {
  if (syncTimer) return

  // Flush queue immediately when actions are enqueued
  flushUnsub = onEnqueue(() => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushQueue()
    }, 500)
  })

  // Initial sync
  const doSync = async () => {
    try {
      await processQueue()
      await incrementalSync()
      await checkSnoozes()
    } catch {
      // Errors already reported via status
    }
  }

  doSync()
  syncTimer = setInterval(doSync, intervalMs)
}

export function stopSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (flushUnsub) {
    flushUnsub()
    flushUnsub = null
  }
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
