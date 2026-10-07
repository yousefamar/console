import { memo, useCallback } from 'react'
import clsx from 'clsx'
import { relativeTime } from '@/utils/date'
import { decodeEntities } from '@/utils/html'
import type { DbThread } from '@/gmail/types'
import { userLabelNames } from '@/gmail/labels'
import { MailLabels } from './MailLabels'
import { Clock, Paperclip } from 'lucide-react'

interface ThreadListItemProps {
  thread: DbThread
  isSelected: boolean
  onSelect: (id: string) => void
  snoozed?: boolean
  labelMap?: Record<string, string>
}

export const ThreadListItem = memo(function ThreadListItem({ thread, isSelected, onSelect, snoozed, labelMap }: ThreadListItemProps) {
  const handleClick = useCallback(() => onSelect(thread.id), [onSelect, thread.id])
  const userLabels = userLabelNames(thread.labelIds, labelMap)

  return (
    <button
      onClick={handleClick}
      className={clsx(
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors duration-fast border-b border-border',
        snoozed && 'opacity-50',
        isSelected
          ? 'bg-surface-2'
          : 'hover:bg-surface-1',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={clsx('truncate text-sm', thread.isUnread ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
          {thread.from}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0 text-xs text-text-tertiary">
          <MailLabels names={userLabels} />
          {thread.hasAttachments && <Paperclip size={10} />}
          {snoozed && <Clock size={10} />}
          {snoozed ? relativeTime(thread.snoozedUntil!) : relativeTime(thread.date)}
        </span>
      </div>
      <span className={clsx('truncate text-sm', thread.isUnread ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
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
})
