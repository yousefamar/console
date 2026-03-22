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

  // Triage (synchronous — DB writes happen in background)
  archiveThread: (threadId?: string) => void
  deleteThread: (threadId?: string) => void
  snoozeThread: (option: 'laterToday' | 'tomorrow' | 'nextWeek' | 'custom', customDate?: Date) => void
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
  undoArchive: (thread: DbThread) => Promise<void>
  undoDelete: (thread: DbThread) => Promise<void>
}

// Threads removed optimistically (before DB confirms) — filtered from live query results
const optimisticallyRemoved = new Set<string>()

export const useInboxStore = create<InboxState>((set, get) => ({
  threads: [],
  selectedThreadId: null,
  selectedMessages: [],
  replyMode: null,
  replyToMessage: null,
  isLoadingThreads: false,

  setThreads: (threads) => {
    // Filter out optimistically removed threads (DB hasn't confirmed yet)
    const filtered = optimisticallyRemoved.size > 0
      ? threads.filter((t) => !optimisticallyRemoved.has(t.id))
      : threads
    set((s) => {
      // If selected thread disappeared from a non-empty list, clear selection
      if (
        s.selectedThreadId &&
        filtered.length > 0 &&
        !filtered.some((t) => t.id === s.selectedThreadId)
      ) {
        return { threads: filtered, selectedThreadId: null, selectedMessages: [] }
      }
      return { threads: filtered }
    })
  },

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
    // Only update if this thread is still selected (guards against async races)
    if (get().selectedThreadId === threadId) {
      set({ selectedMessages: messages })
    }
  },

  archiveThread: (threadId) => {
    const id = threadId ?? get().selectedThreadId
    if (!id) return

    // Get thread from store synchronously (no await)
    const thread = get().threads.find((t) => t.id === id)
    if (!thread) return

    // Prevent live query from re-adding this thread before DB confirms
    optimisticallyRemoved.add(id)

    // Optimistic: synchronous set() — instant UI
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

    // Undo (synchronous — uses store snapshot)
    useUiStore.getState().setUndoAction({
      label: 'Archived',
      expiresAt: Date.now() + 5000,
      undo: () => get().undoArchive(thread),
    })

    // Everything below is background — no awaits blocking the UI
    const newSelectedId = get().selectedThreadId
    const bg = async () => {
      if (newSelectedId) {
        await get().loadMessages(newSelectedId)
        const next = get().threads.find((t) => t.id === newSelectedId)
        if (next?.isUnread) await get().markRead(newSelectedId)
      } else {
        set({ selectedMessages: [] })
      }
      await db.threads.delete(id)
      optimisticallyRemoved.delete(id)
      await enqueue('archive', {}, { threadId: id })
      evictThreadAttachments(id)
    }
    bg().catch(() => {})
  },

  deleteThread: (threadId) => {
    const id = threadId ?? get().selectedThreadId
    if (!id) return

    const thread = get().threads.find((t) => t.id === id)
    if (!thread) return

    optimisticallyRemoved.add(id)

    // Optimistic: synchronous set() — instant UI
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

    // Read messages before deleting (needed for undo), then delete
    let savedMessages: DbMessage[] = []
    useUiStore.getState().setUndoAction({
      label: 'Deleted',
      expiresAt: Date.now() + 5000,
      undo: async () => {
        for (const msg of savedMessages) await db.messages.put(msg)
        await get().undoDelete(thread)
      },
    })

    const newSelectedId = get().selectedThreadId
    const bg = async () => {
      if (newSelectedId) {
        await get().loadMessages(newSelectedId)
        const next = get().threads.find((t) => t.id === newSelectedId)
        if (next?.isUnread) await get().markRead(newSelectedId)
      } else {
        set({ selectedMessages: [] })
      }
      savedMessages = await db.messages.where('threadId').equals(id).toArray()
      await db.threads.delete(id)
      await db.messages.where('threadId').equals(id).delete()
      optimisticallyRemoved.delete(id)
      await enqueue('trash', {}, { threadId: id })
    }
    bg().catch(() => {})
  },

  snoozeThread: (option, customDate) => {
    const id = get().selectedThreadId
    if (!id) return

    const snoozedUntil = getSnoozeTime(option, customDate)

    optimisticallyRemoved.add(id)

    // Optimistic: synchronous set() — instant UI
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
    const bg = async () => {
      if (newSelectedId) {
        await get().loadMessages(newSelectedId)
        const next = get().threads.find((t) => t.id === newSelectedId)
        if (next?.isUnread) await get().markRead(newSelectedId)
      } else {
        set({ selectedMessages: [] })
      }
      await db.threads.update(id, { snoozedUntil })
      optimisticallyRemoved.delete(id)
      await enqueue('snooze', { snoozedUntil }, { threadId: id })
    }
    bg().catch(() => {})

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

  undoArchive: async (thread) => {
    // Allow live query to see this thread again
    optimisticallyRemoved.delete(thread.id)
    // Restore thread record (messages are still in DB — archive only deletes the thread)
    await db.threads.put(thread)
    await removeByThread(thread.id, 'archive')
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

  undoDelete: async (thread) => {
    optimisticallyRemoved.delete(thread.id)
    await db.threads.put(thread)
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
