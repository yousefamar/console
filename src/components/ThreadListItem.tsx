import clsx from 'clsx'
import { relativeTime } from '@/utils/date'
import { decodeEntities } from '@/utils/html'
import type { DbThread } from '@/gmail/types'
import { Clock, Paperclip } from 'lucide-react'

interface ThreadListItemProps {
  thread: DbThread
  isSelected: boolean
  onClick: () => void
  snoozed?: boolean
}

export function ThreadListItem({ thread, isSelected, onClick, snoozed }: ThreadListItemProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors duration-fast border-b border-border',
        snoozed && 'opacity-50',
        isSelected
          ? 'bg-surface-2'
          : 'hover:bg-surface-1',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-text-secondary">
          {thread.from}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0 text-xs text-text-tertiary">
          {thread.hasAttachments && <Paperclip size={10} />}
          {snoozed && <Clock size={10} />}
          {snoozed ? relativeTime(thread.snoozedUntil!) : relativeTime(thread.date)}
        </span>
      </div>
      <span className="truncate text-sm text-text-secondary">
        {thread.subject}
      </span>
      <span className="truncate text-xs text-text-tertiary">
        {decodeEntities(thread.snippet)}
      </span>
      {thread.messageCount > 1 && (
        <span className="text-xs text-text-tertiary">
          {thread.messageCount} messages
        </span>
      )}
    </button>
  )
}
