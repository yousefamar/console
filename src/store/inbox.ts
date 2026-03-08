import { create } from 'zustand'
import { db } from '@/db'
import { enqueue, removeByThread } from '@/db/sync-queue'
import type { DbThread, DbMessage } from '@/gmail/types'
import { useUiStore } from './ui'
import { useComposeStore } from './compose'
import { getSnoozeTime } from '@/utils/date'
import { evictThreadAttachments } from '@/utils/attachment-cache'

interface InboxState {
  threads: DbThread[]
  selectedThreadId: string | null
  selectedMessages: DbMessage[]
  replyMode: 'reply' | 'replyAll' | 'forward' | null
  replyToMessage: DbMessage | null
  isLoadingThreads: boolean

  // Actions
  setThreads: (threads: DbThread[]) => void
  selectThread: (threadId: string | null) => void
  selectNextThread: () => void
  selectPrevThread: () => void
  loadMessages: (threadId: string) => Promise<void>

  // Triage
  archiveThread: (threadId?: string) => Promise<void>
  deleteThread: (threadId?: string) => Promise<void>
  snoozeThread: (option: 'laterToday' | 'tomorrow' | 'nextWeek' | 'custom', customDate?: Date) => Promise<void>
  markRead: (threadId?: string) => Promise<void>

  // Reply
  setReplyMode: (mode: 'reply' | 'replyAll' | 'forward' | null, message?: DbMessage | null) => void

  // Send
  sendReply: (opts: {
    from?: string
    html: string
    to: string
    cc?: string
    subject: string
    inReplyTo?: string
    references?: string
    attachments?: { filename: string; mimeType: string; data: string }[]
  }) => Promise<void>

  // Undo support
  undoArchive: (thread: DbThread, messages: DbMessage[]) => Promise<void>
  undoDelete: (thread: DbThread, messages: DbMessage[]) => Promise<void>
}

export const useInboxStore = create<InboxState>((set, get) => ({
  threads: [],
  selectedThreadId: null,
  selectedMessages: [],
  replyMode: null,
  replyToMessage: null,
  isLoadingThreads: false,

  setThreads: (threads) => set({ threads }),

  selectThread: async (threadId) => {
    set({ selectedThreadId: threadId, replyMode: null, replyToMessage: null })
    useComposeStore.getState().reset()
    if (threadId) {
      const thread = get().threads.find((t) => t.id === threadId)

      await get().loadMessages(threadId)

      if (thread?.isUnread) {
        await get().markRead(threadId)
      }
    } else {
      set({ selectedMessages: [] })
    }
  },

  selectNextThread: () => {
    const { threads, selectedThreadId } = get()
    if (threads.length === 0) return
    if (!selectedThreadId) {
      get().selectThread(threads[0]!.id)
      return
    }
    const idx = threads.findIndex((t) => t.id === selectedThreadId)
    if (idx < threads.length - 1) {
      get().selectThread(threads[idx + 1]!.id)
    }
  },

  selectPrevThread: () => {
    const { threads, selectedThreadId } = get()
    if (threads.length === 0) return
    if (!selectedThreadId) {
      get().selectThread(threads[threads.length - 1]!.id)
      return
    }
    const idx = threads.findIndex((t) => t.id === selectedThreadId)
    if (idx > 0) {
      get().selectThread(threads[idx - 1]!.id)
    }
  },

  loadMessages: async (threadId) => {
    const messages = await db.messages
      .where('threadId')
      .equals(threadId)
      .sortBy('date')
    set({ selectedMessages: messages })
  },

  archiveThread: async (threadId) => {
    const id = threadId ?? get().selectedThreadId
    if (!id) return

    // Save for undo
    const thread = await db.threads.get(id)
    const messages = await db.messages.where('threadId').equals(id).toArray()
    if (!thread) return


    // Optimistic: remove from local
    await db.threads.delete(id)
    set((s) => {
      const newThreads = s.threads.filter((t) => t.id !== id)
      const wasSelected = s.selectedThreadId === id
      const currentIdx = s.threads.findIndex((t) => t.id === id)
      const nextThread = wasSelected
        ? newThreads[Math.min(currentIdx, newThreads.length - 1)]
        : null
      return {
        threads: newThreads,
        selectedThreadId: wasSelected ? (nextThread?.id ?? null) : s.selectedThreadId,
      }
    })

    // Load messages for the newly selected thread
    const newSelectedId = get().selectedThreadId
    if (newSelectedId) {
      await get().loadMessages(newSelectedId)
    } else {
      set({ selectedMessages: [] })
    }

    // Queue for sync
    await enqueue('archive', {}, { threadId: id })

    // Evict cached attachment data
    evictThreadAttachments(id)

    // Set undo
    useUiStore.getState().setUndoAction({
      label: 'Archived',
      expiresAt: Date.now() + 5000,
      undo: () => get().undoArchive(thread, messages),
    })
  },

  deleteThread: async (threadId) => {
    const id = threadId ?? get().selectedThreadId
    if (!id) return

    const thread = await db.threads.get(id)
    const messages = await db.messages.where('threadId').equals(id).toArray()
    if (!thread) return

    // Optimistic remove
    await db.threads.delete(id)
    await db.messages.where('threadId').equals(id).delete()
    set((s) => {
      const newThreads = s.threads.filter((t) => t.id !== id)
      const wasSelected = s.selectedThreadId === id
      const currentIdx = s.threads.findIndex((t) => t.id === id)
      const nextThread = wasSelected
        ? newThreads[Math.min(currentIdx, newThreads.length - 1)]
        : null
      return {
        threads: newThreads,
        selectedThreadId: wasSelected ? (nextThread?.id ?? null) : s.selectedThreadId,
      }
    })

    const newSelectedId = get().selectedThreadId
    if (newSelectedId) {
      await get().loadMessages(newSelectedId)
    } else {
      set({ selectedMessages: [] })
    }

    await enqueue('trash', {}, { threadId: id })

    useUiStore.getState().setUndoAction({
      label: 'Deleted',
      expiresAt: Date.now() + 5000,
      undo: () => get().undoDelete(thread, messages),
    })
  },

  snoozeThread: async (option, customDate) => {
    const id = get().selectedThreadId
    if (!id) return

    const snoozedUntil = getSnoozeTime(option, customDate)

    // Optimistic: update thread with snooze time and remove from visible list
    await db.threads.update(id, { snoozedUntil })
    set((s) => {
      const newThreads = s.threads.filter((t) => t.id !== id)
      const currentIdx = s.threads.findIndex((t) => t.id === id)
      const nextThread = newThreads[Math.min(currentIdx, newThreads.length - 1)]
      return {
        threads: newThreads,
        selectedThreadId: nextThread?.id ?? null,
      }
    })

    const newSelectedId = get().selectedThreadId
    if (newSelectedId) {
      await get().loadMessages(newSelectedId)
    } else {
      set({ selectedMessages: [] })
    }

    // Queue archive for sync (snooze = archive + local timer)
    await enqueue('snooze', { snoozedUntil }, { threadId: id })

    useUiStore.getState().setShowSnoozePicker(false)
  },

  markRead: async (threadId) => {
    const id = threadId ?? get().selectedThreadId
    if (!id) return

    await db.threads.update(id, { isUnread: false })
    set((s) => ({
      threads: s.threads.map((t) => (t.id === id ? { ...t, isUnread: false } : t)),
    }))

    await enqueue('markRead', {}, { threadId: id })
  },

  setReplyMode: (mode, message) => set({ replyMode: mode, replyToMessage: message ?? null }),

  sendReply: async (opts) => {
    const threadId = get().selectedThreadId
    if (!threadId) return

    await enqueue(
      'send',
      { ...opts, threadId },
      { threadId },
    )

    set({ replyMode: null })

    // Auto-archive after sending (inbox-zero: dealt with = done)
    await get().archiveThread(threadId)
  },

  undoArchive: async (thread, messages) => {
    // Restore locally
    await db.threads.put(thread)
    for (const msg of messages) {
      await db.messages.put(msg)
    }
    // Remove the archive action from queue
    await removeByThread(thread.id, 'archive')
    // Queue unarchive
    await enqueue('unarchive', {}, { threadId: thread.id })

    // Refresh thread list and re-select the restored thread
    const threads = await db.threads
      .filter((t) => t.labelIds.includes('INBOX') && !t.snoozedUntil)
      .reverse()
      .sortBy('date')
    set({ threads, selectedThreadId: thread.id })
    await get().loadMessages(thread.id)
    useUiStore.getState().setUndoAction(null)
  },

  undoDelete: async (thread, messages) => {
    await db.threads.put(thread)
    for (const msg of messages) {
      await db.messages.put(msg)
    }
    await removeByThread(thread.id, 'trash')

    const threads = await db.threads
      .filter((t) => t.labelIds.includes('INBOX') && !t.snoozedUntil)
      .reverse()
      .sortBy('date')
    set({ threads, selectedThreadId: thread.id })
    await get().loadMessages(thread.id)
    useUiStore.getState().setUndoAction(null)
  },
}))
