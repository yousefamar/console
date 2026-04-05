import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ThreadList } from './ThreadList'
import { ThreadView } from './ThreadView'
import { ChatRoomList } from './ChatRoomList'
import { ChatRoomView } from './ChatRoomView'
import { SyncStatus } from './SyncStatus'
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useSwipeActions } from '@/hooks/useSwipeActions'
import { incrementalSync, fullSync } from '@/gmail/sync'
import { isSignedIn as isGmailConnected, signIn as gmailSignIn } from '@/gmail/auth'
import { isMatrixConnected } from '@/matrix/auth'
import { db } from '@/db'
import { evictAll } from '@/utils/email-cache'
import { RefreshCw, Mail, MessageCircle, Bot, Bookmark, FileText, Rss, CalendarDays, PoundSterling, Settings } from 'lucide-react'
import { AgentTab } from './AgentTab'
import { BookmarkTab } from './BookmarkTab'
import { NotesTab } from './NotesTab'
import { FeedTab } from './FeedTab'
import { CalendarTab } from './CalendarTab'
import { MoneyTab } from './MoneyTab'
import { useFeedStore } from '@/store/feeds'

// ---------- MailTab (isolates inbox store subscriptions) ----------

function MailTab() {
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const archiveThread = useInboxStore((s) => s.archiveThread)
  const snoozeThread = useInboxStore((s) => s.snoozeThread)
  const isMobile = useIsMobile()

  const [showSnoozed, setShowSnoozed] = useState(false)

  const showDetail = isMobile ? !!selectedThreadId : true
  const showList = isMobile ? !selectedThreadId : true

  // Snoozed thread count
  const snoozedCount = useLiveQuery(
    () => db.threads.filter((t) => !!t.snoozedUntil).count(),
    [],
  )

  // Swipe refs for mobile
  const swipeContainerRef = useRef<HTMLDivElement>(null)
  const swipeContentRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeRight: () => archiveThread(),
    onSwipeLeft: () => snoozeThread('tomorrow'),
  })

  const gmailConnected = isGmailConnected()

  if (!gmailConnected) {
    return <MailConnectScreen />
  }

  return (
    <>
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
          {!!snoozedCount && (
            <div className="flex items-center border-b border-border px-3 py-1">
              <button
                onClick={() => setShowSnoozed(!showSnoozed)}
                className={`text-xs transition-colors duration-fast ${showSnoozed ? 'text-text-secondary' : 'text-text-tertiary hover:text-text-secondary'}`}
                title="Toggle snoozed threads"
              >
                {showSnoozed ? 'hide snoozed' : `${snoozedCount} snoozed`}
              </button>
            </div>
          )}
          <div className="flex-1 overflow-hidden">
            <ThreadList showSnoozed={showSnoozed} />
          </div>
        </div>
      )}
      {showDetail && (
        <div
          ref={swipeContainerRef}
          className="flex-1 min-w-0 flex flex-col relative overflow-hidden"
        >
          {isMobile ? (
            <div
              ref={swipeContentRef}
              className="flex-1 min-h-0 flex flex-col relative"
              onTouchStart={swipe.onTouchStart}
              onTouchMove={swipe.onTouchMove}
              onTouchEnd={swipe.onTouchEnd}
            >
              <ThreadView />
            </div>
          ) : (
            <ThreadView />
          )}
        </div>
      )}
    </>
  )
}

// ---------- ChatTab (isolates chat store subscriptions) ----------

function ChatTab() {
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const markRoomRead = useChatStore((s) => s.markRoomRead)
  const isMobile = useIsMobile()

  const showDetail = isMobile ? !!selectedRoomId : true
  const showList = isMobile ? !selectedRoomId : true

  // Swipe refs for mobile
  const swipeContainerRef = useRef<HTMLDivElement>(null)
  const swipeContentRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeRight: () => markRoomRead(),
  })

  return (
    <>
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
          <div className="flex-1 overflow-hidden">
            <ChatRoomList />
          </div>
        </div>
      )}
      {showDetail && (
        <div className="flex-1 min-w-0 flex flex-col relative overflow-hidden">
          {isMobile ? (
            <div
              ref={swipeContainerRef}
              className="flex-1 min-h-0 flex flex-col relative"
            >
              <div
                ref={swipeContentRef}
                className="flex-1 min-h-0 flex flex-col relative"
                onTouchStart={swipe.onTouchStart}
                onTouchMove={swipe.onTouchMove}
                onTouchEnd={swipe.onTouchEnd}
              >
                <ChatRoomView />
              </div>
            </div>
          ) : (
            <ChatRoomView />
          )}
        </div>
      )}
    </>
  )
}

// ---------- Layout (no inbox/chat store subscriptions) ----------

export function Layout() {
  const activePane = useUiStore((s) => s.activePane)
  const setActivePane = useUiStore((s) => s.setActivePane)
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const setShowAccountModal = useUiStore((s) => s.setShowAccountModal)
  const isMobile = useIsMobile()

  const gmailConnected = isGmailConnected()
  const matrixConnected = isMatrixConnected()

  const isEmail = activePane === 'email'
  const isChat = activePane === 'chat'
  const isBookmarks = activePane === 'bookmarks'
  const isNotes = activePane === 'notes'
  const isAgents = activePane === 'agents'
  const isFeeds = activePane === 'feeds'
  const isCalendar = activePane === 'calendar'
  const isMoney = activePane === 'money'

  // Pane-aware refresh handler
  const handleRefresh = async (e: React.MouseEvent) => {
    e.preventDefault()
    if (isEmail) {
      if (e.ctrlKey || e.metaKey) {
        const snoozed = await db.threads.filter((t) => !!t.snoozedUntil).toArray()
        await db.threads.clear()
        await db.messages.clear()
        await db.attachmentData.clear()
        await db.meta.delete('historyId')
        if (snoozed.length > 0) {
          await db.threads.bulkPut(snoozed)
        }
        evictAll()
        await fullSync()
      } else {
        await incrementalSync()
      }
    } else if (isFeeds) {
      if (e.ctrlKey || e.metaKey) {
        await db.feedItems.clear()
        const { useFeedStore } = await import('@/store/feeds')
        useFeedStore.setState({ lastSync: null })
        await useFeedStore.getState().refreshItems()
      } else {
        const { useFeedStore } = await import('@/store/feeds')
        await useFeedStore.getState().refreshItems()
      }
    } else if (isCalendar) {
      if (e.ctrlKey || e.metaKey) {
        await db.calendarEvents.clear()
        const { useCalendarStore } = await import('@/store/calendar')
        await useCalendarStore.getState().refreshAll()
      } else {
        const { useCalendarStore } = await import('@/store/calendar')
        await useCalendarStore.getState().refreshAll()
      }
    } else if (isMoney) {
      const { useMoneyStore } = await import('@/store/money')
      await useMoneyStore.getState().refreshSync()
    } else if (isChat && matrixConnected) {
      if (e.ctrlKey || e.metaKey) {
        await db.chatMessages.clear()
        await db.meta.delete('matrixSyncToken')
        const { fullMatrixSync } = await import('@/matrix/sync')
        await fullMatrixSync()
      } else {
        const { incrementalMatrixSync } = await import('@/matrix/sync')
        await incrementalMatrixSync()
      }
    }
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-3 md:px-4 py-1.5">
        <div className="flex items-center gap-3">
          <HeaderTitle isMobile={isMobile} />

          {/* Top-level pane tabs */}
          <div className="flex items-center gap-0.5">
            {gmailConnected ? (
              <PaneTab pane="email" icon={<Mail size={11} />} label="Mail" activePane={activePane} setActivePane={setActivePane} />
            ) : (
              <button
                onClick={() => setActivePane('email')}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors duration-fast ${
                  isEmail ? 'text-text-primary bg-surface-2' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <Mail size={11} />
                <span>+Mail</span>
              </button>
            )}
            {matrixConnected ? (
              <PaneTab pane="chat" icon={<MessageCircle size={11} />} label="Chat" activePane={activePane} setActivePane={setActivePane} />
            ) : (
              <button
                onClick={() => setShowMatrixLogin(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-text-tertiary hover:text-text-secondary rounded-sm transition-colors duration-fast"
              >
                <MessageCircle size={11} />
                <span>+Chat</span>
              </button>
            )}
            <PaneTab pane="bookmarks" icon={<Bookmark size={11} />} label="Bookmarks" activePane={activePane} setActivePane={setActivePane} />
            <PaneTab pane="notes" icon={<FileText size={11} />} label="Notes" activePane={activePane} setActivePane={setActivePane} />
            <PaneTab pane="feeds" icon={<Rss size={11} />} label="Feeds" activePane={activePane} setActivePane={setActivePane} />
            <PaneTab pane="calendar" icon={<CalendarDays size={11} />} label="Calendar" activePane={activePane} setActivePane={setActivePane} />
            <PaneTab pane="money" icon={<PoundSterling size={11} />} label="Money" activePane={activePane} setActivePane={setActivePane} />
            <PaneTab pane="agents" icon={<Bot size={11} />} label="Agents" activePane={activePane} setActivePane={setActivePane} />
          </div>
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <SyncStatus />
          {!isAgents && !isBookmarks && !isNotes && (isEmail ? gmailConnected : isFeeds || isCalendar || isMoney ? true : matrixConnected) && (
            <button
              onClick={handleRefresh}
              className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              title="Refresh (Ctrl+click for full resync)"
            >
              <RefreshCw size={12} />
            </button>
          )}
          <button
            onClick={() => setShowAccountModal(true)}
            className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
            title="Settings"
          >
            <Settings size={13} />
          </button>
          {!isMobile && (
            <span className="text-xs text-text-tertiary">
              <kbd className="font-mono">?</kbd> help
            </span>
          )}
        </div>
      </header>

      {/* Main content — all panes always mounted, toggled with display */}
      <div className="flex flex-1 min-h-0">
        {/* Mail pane */}
        <div className={`flex flex-1 min-h-0 ${isEmail ? '' : 'hidden'}`}>
          <MailTab />
        </div>

        {/* Chat pane */}
        <div className={`flex flex-1 min-h-0 ${isChat ? '' : 'hidden'}`}>
          <ChatTab />
        </div>

        {/* Bookmarks pane */}
        <div className={`flex flex-1 min-h-0 ${isBookmarks ? '' : 'hidden'}`}>
          <BookmarkTab />
        </div>

        {/* Notes pane */}
        <div className={`flex flex-1 min-h-0 ${isNotes ? '' : 'hidden'}`}>
          <NotesTab />
        </div>

        {/* Feeds pane */}
        <div className={`flex flex-1 min-h-0 ${isFeeds ? '' : 'hidden'}`}>
          <FeedTab />
        </div>

        {/* Calendar pane */}
        <div className={`flex flex-1 min-h-0 ${isCalendar ? '' : 'hidden'}`}>
          <CalendarTab />
        </div>

        {/* Money pane */}
        <div className={`flex flex-1 min-h-0 ${isMoney ? '' : 'hidden'}`}>
          <MoneyTab />
        </div>

        {/* Agents pane */}
        <div className={`flex flex-1 min-h-0 ${isAgents ? '' : 'hidden'}`}>
          <AgentTab />
        </div>
      </div>

      {/* Bottom action bar */}
      <Footer activePane={activePane} isMobile={isMobile} />
    </div>
  )
}

// ---------- Header title (isolates selectThread/selectRoom for mobile back nav) ----------

function HeaderTitle({ isMobile }: { isMobile: boolean }) {
  const activePane = useUiStore((s) => s.activePane)

  const handleClick = isMobile ? () => {
    if (activePane === 'email') {
      useInboxStore.getState().selectThread(null)
    } else if (activePane === 'chat') {
      useChatStore.getState().selectRoom(null)
    }
  } : undefined

  return (
    <h1
      className="text-sm font-semibold text-text-primary tracking-tight"
      onClick={handleClick}
    >
      Console
    </h1>
  )
}

// ---------- PaneTab with isolated count subscriptions ----------

import type { ActivePane } from '@/store/ui'
import type { ReactNode } from 'react'

function PaneTab({ pane, icon, label, activePane, setActivePane }: {
  pane: ActivePane
  icon: ReactNode
  label: string
  activePane: ActivePane
  setActivePane: (p: ActivePane) => void
}) {
  const isActive = activePane === pane

  // Only Mail, Chat, and Feeds tabs show counts — subscribe selectively
  const count = pane === 'email'
    ? useInboxStore((s) => s.threads.length)
    : pane === 'chat'
      ? useChatStore((s) => s.rooms.length)
      : pane === 'feeds'
        ? useFeedStore((s) => s.totalUnread)
        : 0

  return (
    <button
      onClick={() => setActivePane(pane)}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors duration-fast ${
        isActive ? 'text-text-primary bg-surface-2' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {icon}
      <span>{label}</span>
      {count > 0 && (
        <span className="text-text-tertiary">({count})</span>
      )}
    </button>
  )
}

// ---------- Footer (isolates inbox/chat action callbacks) ----------

function Footer({ activePane, isMobile }: { activePane: ActivePane; isMobile: boolean }) {
  const setShowSnoozePicker = useUiStore((s) => s.setShowSnoozePicker)
  const isEmail = activePane === 'email'
  const isAgents = activePane === 'agents'
  const isBookmarks = activePane === 'bookmarks'
  const isNotes = activePane === 'notes'
  const isFeeds = activePane === 'feeds'
  const isCalendar = activePane === 'calendar'
  const isMoney = activePane === 'money'

  const handleDone = () => {
    if (isEmail) useInboxStore.getState().archiveThread()
    else if (isFeeds) useFeedStore.getState().markRead()
    else useChatStore.getState().markRoomRead()
  }

  return (
    <footer className="flex items-center justify-between border-t border-border px-3 md:px-4 py-1 md:py-1">
      <div className="flex items-center gap-3 md:gap-4">
        {isAgents || isBookmarks || isNotes || isCalendar || isMoney ? (
          <></>
        ) : isFeeds ? (
          <>
            <ActionHint keyLabel="e" action="Read" onClick={handleDone} mobile={isMobile} />
            <ActionHint keyLabel="o" action="Open" onClick={() => useFeedStore.getState().openItemInBrowser()} mobile={isMobile} />
          </>
        ) : (
          <>
            <ActionHint
              keyLabel="e"
              action={isEmail ? 'Done' : 'Read'}
              onClick={handleDone}
              mobile={isMobile}
            />
            <ActionHint keyLabel="b" action="Snooze" onClick={() => setShowSnoozePicker(true)} mobile={isMobile} />
            {!isMobile && isEmail && (
              <>
                <ActionHint keyLabel="r" action="Reply" mobile={false} />
                <ActionHint keyLabel="c" action="Compose" mobile={false} />
              </>
            )}
          </>
        )}
      </div>
      {!isMobile && (
        <div className="flex items-center gap-3 text-xs text-text-tertiary">
          {isAgents ? (
            <>
              <span><kbd className="font-mono">Esc</kbd> interrupt</span>
              <span><kbd className="font-mono">Enter</kbd> focus input</span>
            </>
          ) : isBookmarks ? (
            <>
              <span><kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> navigate</span>
              <span><kbd className="font-mono">e</kbd> keep</span>
              <span><kbd className="font-mono">d</kbd> delete</span>
              <span><kbd className="font-mono">o</kbd> open</span>
              <span><kbd className="font-mono">m</kbd> triage</span>
            </>
          ) : isFeeds ? (
            <>
              <span><kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> navigate</span>
              <span><kbd className="font-mono">e</kbd> read</span>
              <span><kbd className="font-mono">o</kbd> open</span>
              <span><kbd className="font-mono">/</kbd> search</span>
            </>
          ) : isCalendar ? (
            <>
              <span><kbd className="font-mono">h</kbd>/<kbd className="font-mono">l</kbd> navigate</span>
              <span><kbd className="font-mono">t</kbd> today</span>
              <span><kbd className="font-mono">w</kbd>/<kbd className="font-mono">d</kbd> view</span>
              <span><kbd className="font-mono">c</kbd> create</span>
            </>
          ) : isMoney ? (
            <>
              <span><kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> navigate</span>
              <span><kbd className="font-mono">/</kbd> search</span>
              <span><kbd className="font-mono">n</kbd> note</span>
              <span><kbd className="font-mono">c</kbd> category</span>
            </>
          ) : isNotes ? (
            <>
              <span><kbd className="font-mono">Ctrl+P</kbd> find file</span>
              <span><kbd className="font-mono">Ctrl+K</kbd> link</span>
              <span><kbd className="font-mono">Ctrl+S</kbd> save</span>
              <span><kbd className="font-mono">Ctrl+N</kbd> new</span>
              <span>vim mode</span>
            </>
          ) : (
            <>
              <span><kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> navigate</span>
              <span><kbd className="font-mono">/</kbd> search</span>
            </>
          )}
          <span><kbd className="font-mono">Tab</kbd> switch pane</span>
        </div>
      )}
    </footer>
  )
}

// ---------- Helpers ----------

function MailConnectScreen() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleConnect = async () => {
    setLoading(true)
    setError('')
    try {
      await gmailSignIn()
      // Reload to start sync
      window.location.reload()
    } catch (err) {
      setError('Sign-in cancelled or failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
      <Mail size={24} className="text-text-tertiary" />
      <p className="text-sm text-text-secondary">Connect your Gmail</p>
      <p className="text-xs text-text-tertiary max-w-xs">
        Sign in with Google to sync your inbox. Your data stays in your browser.
      </p>
      <button
        onClick={handleConnect}
        disabled={loading}
        className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors disabled:opacity-50"
      >
        {loading ? 'Connecting...' : 'Sign in with Google'}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ActionHint({ keyLabel, action, onClick, mobile }: { keyLabel: string; action: string; onClick?: () => void; mobile: boolean }) {
  if (mobile) {
    return (
      <button
        onClick={onClick}
        className="flex items-center justify-center px-3 py-2 text-xs font-medium text-text-secondary active:text-text-primary active:bg-surface-2 rounded-sm transition-colors duration-fast"
      >
        {action}
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
    >
      <kbd className="rounded-sm border border-border bg-surface-2 px-1 py-0.5 font-mono text-[10px]">
        {keyLabel}
      </kbd>
      <span>{action}</span>
    </button>
  )
}
