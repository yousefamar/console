import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'
import { MessageView } from './MessageView'
import { ComposeEditor } from './ComposeEditor'
import { InboxZero } from './InboxZero'
import { useIsMobile } from '@/hooks/useMediaQuery'
import type { DbMessage } from '@/gmail/types'

export function ThreadView() {
  return (
    <div className="flex h-full flex-col">
      <ThreadViewHeader />
      <ThreadViewMessages />
      <ThreadViewCompose />
    </div>
  )
}

// ---------- Header: thread subject + dark mode toggle ----------

function ThreadViewHeader() {
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const threads = useInboxStore((s) => s.threads)
  const emailDarkMode = useUiStore((s) => s.emailDarkMode)
  const toggleEmailDarkMode = useUiStore((s) => s.toggleEmailDarkMode)

  const inboxThread = threads.find((t) => t.id === selectedThreadId)
  const snoozedThread = useLiveQuery(
    async () => selectedThreadId && !inboxThread
      ? db.threads.get(selectedThreadId)
      : undefined,
    [selectedThreadId, inboxThread],
  )
  const thread = inboxThread ?? snoozedThread

  if (!selectedThreadId || !thread) return null

  return (
    <div className="flex items-center justify-between border-b border-border px-3 md:px-4 py-2">
      <h2 className="truncate text-base md:text-lg font-medium text-text-primary">
        {thread.subject}
      </h2>
      <button
        onClick={toggleEmailDarkMode}
        className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast px-2 py-1"
        title={emailDarkMode ? 'Show original email colors' : 'Apply dark mode to emails'}
      >
        {emailDarkMode ? 'Original' : 'Dark'}
      </button>
    </div>
  )
}

// ---------- Messages: the heavy rendering ----------

function ThreadViewMessages() {
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const threads = useInboxStore((s) => s.threads)
  const selectedMessages = useInboxStore((s) => s.selectedMessages)

  // Load ALL messages for ALL inbox threads — they stay mounted
  const allMessagesByThread = useLiveQuery(async () => {
    const inboxThreads = await db.threads
      .filter((t) => t.labelIds.includes('INBOX') && !t.snoozedUntil)
      .toArray()
    const map = new Map<string, DbMessage[]>()
    for (const thread of inboxThreads) {
      const msgs = await db.messages
        .where('threadId')
        .equals(thread.id)
        .sortBy('date')
      map.set(thread.id, msgs)
    }
    return map
  }, [])

  // InboxZero when no threads
  if (threads.length === 0 && !selectedThreadId) {
    return (
      <div className="flex-1 overflow-y-auto">
        <InboxZero />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {allMessagesByThread && Array.from(allMessagesByThread.entries()).map(([threadId, messages]) => {
        const isVisible = threadId === selectedThreadId
        return (
          <div
            key={threadId}
            style={{ display: isVisible ? 'block' : 'none' }}
          >
            {messages.map((msg, i) => (
              <MessageView
                key={msg.id}
                message={msg}
                isLast={i === messages.length - 1}
                visible={isVisible}
              />
            ))}
          </div>
        )
      })}

      {selectedThreadId && !allMessagesByThread?.has(selectedThreadId) && (
        selectedMessages.length > 0 ? (
          <div>
            {selectedMessages.map((msg, i) => (
              <MessageView
                key={msg.id}
                message={msg}
                isLast={i === selectedMessages.length - 1}
                visible
              />
            ))}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-text-tertiary">Loading...</p>
          </div>
        )
      )}

      {!selectedThreadId && (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-text-tertiary">Select a thread</p>
        </div>
      )}
    </div>
  )
}

// ---------- Compose: reply/forward buttons + editor ----------

function ThreadViewCompose() {
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const replyMode = useInboxStore((s) => s.replyMode)
  const replyToMessage = useInboxStore((s) => s.replyToMessage)
  const setReplyMode = useInboxStore((s) => s.setReplyMode)
  const isMobile = useIsMobile()

  if (!selectedThreadId) return null

  // Snapshot selectedMessages to get lastMessage without subscribing
  const selectedMessages = useInboxStore.getState().selectedMessages
  const lastMessage = replyToMessage ?? selectedMessages[selectedMessages.length - 1]

  return (
    <>
      {replyMode ? (
        <ComposeEditor
          mode={replyMode}
          lastMessage={lastMessage}
          onClose={() => setReplyMode(null)}
        />
      ) : (
        <div className="border-t border-border px-4 py-2">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setReplyMode('reply')}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast"
            >
              {!isMobile && <span className="text-text-tertiary mr-1">r</span>}Reply
            </button>
            <button
              onClick={() => setReplyMode('replyAll')}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast"
            >
              {!isMobile && <span className="text-text-tertiary mr-1">R</span>}Reply all
            </button>
            <button
              onClick={() => setReplyMode('forward')}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast"
            >
              {!isMobile && <span className="text-text-tertiary mr-1">f</span>}Forward
            </button>
          </div>
        </div>
      )}
    </>
  )
}
