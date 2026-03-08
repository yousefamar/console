import { useState } from 'react'
import type { DbMessage } from '@/gmail/types'
import { formatDate } from '@/utils/date'
import { parseAddressList } from '@/utils/email'
import { decodeEntities } from '@/utils/html'
import { EmailFrame } from './EmailFrame'
import { AttachmentBar } from './AttachmentBar'
import { useInboxStore } from '@/store/inbox'
import { Reply, ReplyAll, Forward, MoreHorizontal } from 'lucide-react'
import { CalendarEventCard } from './CalendarEventCard'

interface MessageViewProps {
  message: DbMessage
  isLast: boolean
  visible: boolean
}

export function MessageView({ message, isLast, visible }: MessageViewProps) {
  const [collapsed, setCollapsed] = useState(!isLast)
  const [menuOpen, setMenuOpen] = useState(false)
  const setReplyMode = useInboxStore((s) => s.setReplyMode)
  const toList = parseAddressList(message.to)
  const ccList = parseAddressList(message.cc)

  return (
    <div className="border-b border-border">
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="flex w-full items-baseline gap-2 px-4 py-2 text-left hover:bg-surface-1 transition-colors duration-fast"
        >
          <span className="text-sm font-medium text-text-secondary truncate">
            {message.from}
          </span>
          <span className="text-xs text-text-tertiary truncate flex-1">
            {decodeEntities(message.snippet)}
          </span>
          <span className="text-xs text-text-tertiary flex-shrink-0">
            {formatDate(message.date)}
          </span>
        </button>
      ) : (
        <>
          {/* Header */}
          <div
            className="flex items-start justify-between gap-4 px-4 py-3 cursor-pointer hover:bg-surface-1 transition-colors duration-fast"
            onClick={() => !isLast && setCollapsed(true)}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-text-primary">
                  {message.from}
                </span>
                <span className="text-xs text-text-tertiary">
                  &lt;{message.fromEmail}&gt;
                </span>
              </div>
              <div className="mt-0.5 text-xs text-text-tertiary">
                To: {toList.map((a) => a.name || a.email).join(', ')}
                {ccList.length > 0 && (
                  <> &middot; Cc: {ccList.map((a) => a.name || a.email).join(', ')}</>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-text-tertiary">
                {formatDate(message.date)}
              </span>
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
                  className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast p-0.5 rounded-sm hover:bg-surface-2"
                >
                  <MoreHorizontal size={14} />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-sm border border-border bg-surface-1 py-1 shadow-lg animate-fade-in">
                      <button
                        onClick={() => { setReplyMode('reply', message); setMenuOpen(false) }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2 transition-colors duration-fast"
                      >
                        <Reply size={12} /> Reply
                      </button>
                      <button
                        onClick={() => { setReplyMode('replyAll', message); setMenuOpen(false) }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2 transition-colors duration-fast"
                      >
                        <ReplyAll size={12} /> Reply all
                      </button>
                      <button
                        onClick={() => { setReplyMode('forward', message); setMenuOpen(false) }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2 transition-colors duration-fast"
                      >
                        <Forward size={12} /> Forward
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Calendar event card */}
      {!collapsed && message.calendarEvent && (
        <CalendarEventCard event={message.calendarEvent} />
      )}

      {/* iframe always mounted, hidden when collapsed */}
      <div className={collapsed ? 'h-0 overflow-hidden' : 'px-4 pb-4'}>
        <EmailFrame messageId={message.id} html={message.bodyHtml} visible={visible && !collapsed} />
      </div>

      {/* Attachments */}
      {!collapsed && message.attachments && message.attachments.length > 0 && (
        <AttachmentBar messageId={message.id} attachments={message.attachments} />
      )}
    </div>
  )
}
