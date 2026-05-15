import { memo, useRef, useState } from 'react'
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
import { getHubUrl } from '@/hub'
import { isMatrixConnected } from '@/matrix/auth'
import { db } from '@/db'
import { evictAll } from '@/utils/email-cache'
import { RefreshCw, Mail, MessageCircle, Bot, Bookmark, FileText, Rss, CalendarDays, PoundSterling, Settings, BellOff, ChevronLeft, Check, Clock, LayoutDashboard, CloudOff } from 'lucide-react'
import { AgentTab } from './AgentTab'
import { HomeTab } from './HomeTab'
import { BookmarkTab } from './BookmarkTab'
import { NotesTab } from './NotesTab'
import { FeedTab } from './FeedTab'
import { YouTubePiP } from './FeedItemView'
import { PullIndicator } from './PullIndicator'
import { CalendarTab } from './CalendarTab'
import { MoneyTab } from './MoneyTab'
import { useFeedStore } from '@/store/feeds'
import { useAgentStore } from '@/store/agent'
import { useBookmarkStore } from '@/store/bookmarks'
import { useNotesStore } from '@/store/notes'
import { useMoneyStore } from '@/store/money'

// ---------- MailTab (isolates inbox store subscriptions) ----------

const MailTab = memo(function MailTab() {
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
  const swipeLeftIconRef = useRef<HTMLDivElement>(null)
  const swipeRightIconRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeRight: () => archiveThread(),
    onSwipeLeft: () => snoozeThread('tomorrow'),
    leftIconRef: swipeLeftIconRef,
    rightIconRef: swipeRightIconRef,
  })

  const gmailConnected = isGmailConnected()

  if (!gmailConnected) {
    return <MailConnectScreen />
  }

  return (
    <>
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'flex-1'} border-r border-border overflow-hidden flex flex-col`}>
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
            <>
              <div ref={swipeLeftIconRef} className="absolute inset-y-0 left-0 flex items-center pl-6 pointer-events-none z-10" style={{ opacity: 0 }}>
                <Check size={24} className="text-green-500" />
              </div>
              <div ref={swipeRightIconRef} className="absolute inset-y-0 right-0 flex items-center pr-6 pointer-events-none z-10" style={{ opacity: 0 }}>
                <Clock size={24} className="text-amber-500" />
              </div>
              <div
                ref={swipeContentRef}
                className="flex-1 min-h-0 flex flex-col relative"
                onTouchStart={swipe.onTouchStart}
                onTouchMove={swipe.onTouchMove}
                onTouchEnd={swipe.onTouchEnd}
              >
                <ThreadView />
              </div>
            </>
          ) : (
            <ThreadView />
          )}
        </div>
      )}
    </>
  )
})

// ---------- ChatTab (isolates chat store subscriptions) ----------

const ChatTab = memo(function ChatTab() {
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const isMobile = useIsMobile()

  const showDetail = isMobile ? !!selectedRoomId : true
  const showList = isMobile ? !selectedRoomId : true

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
          <ChatRoomView />
        </div>
      )}
    </>
  )
})

// ---------- Layout (no inbox/chat store subscriptions) ----------

export function Layout() {
  const activePane = useUiStore((s) => s.activePane)
  const setActivePane = useUiStore((s) => s.setActivePane)
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const setShowAccountModal = useUiStore((s) => s.setShowAccountModal)
  const isMobile = useIsMobile()

  const gmailConnected = isGmailConnected()
  const matrixConnected = isMatrixConnected()

  const isHome = activePane === 'home'
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

    // In the APK, also re-poll for an APK update — the native-side check only
    // runs on cold start otherwise. Safe no-op in the browser.
    try {
      const bridge = (window as unknown as { ConsoleNative?: { checkForUpdate?: () => void } }).ConsoleNative
      bridge?.checkForUpdate?.()
    } catch { /* ignore */ }

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
      }
      const { hubBus } = await import('@/sync-bus')
      await hubBus.rpc('matrix', 'syncNow', {}).catch(() => {})
    }
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-3 md:px-4 py-1.5">
        <div className="flex items-center gap-3">
          {isMobile && <MobileBackButton activePane={activePane} />}
          {/* Top-level pane tabs (desktop only — mobile uses bottom tab bar) */}
          {!isMobile && (
            <div className="flex items-center gap-0.5">
              <PaneTab pane="home" icon={<LayoutDashboard size={11} />} label="Home" activePane={activePane} setActivePane={setActivePane} />
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
              <PaneTab pane="calendar" icon={<CalendarDays size={11} />} label="Calendar" activePane={activePane} setActivePane={setActivePane} />
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
              <PaneTab pane="agents" icon={<Bot size={11} />} label="Agents" activePane={activePane} setActivePane={setActivePane} />
              <PaneTab pane="feeds" icon={<Rss size={11} />} label="Feeds" activePane={activePane} setActivePane={setActivePane} />
              <PaneTab pane="notes" icon={<FileText size={11} />} label="Notes" activePane={activePane} setActivePane={setActivePane} />
              <PaneTab pane="bookmarks" icon={<Bookmark size={11} />} label="Bookmarks" activePane={activePane} setActivePane={setActivePane} />
              <PaneTab pane="money" icon={<PoundSterling size={11} />} label="Money" activePane={activePane} setActivePane={setActivePane} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <HubOfflineIndicator />
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
          <DndIndicator />
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
        {/* Home pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isHome ? '' : 'hidden'}`}>
          <HomeTab />
        </div>

        {/* Mail pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isEmail ? '' : 'hidden'}`}>
          <MailTab />
        </div>

        {/* Chat pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isChat ? '' : 'hidden'}`}>
          <ChatTab />
        </div>

        {/* Bookmarks pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isBookmarks ? '' : 'hidden'}`}>
          <BookmarkTab />
        </div>

        {/* Notes pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isNotes ? '' : 'hidden'}`}>
          <NotesTab />
        </div>

        {/* Feeds pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isFeeds ? '' : 'hidden'}`}>
          <FeedTab />
        </div>

        {/* Calendar pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isCalendar ? '' : 'hidden'}`}>
          <CalendarTab />
        </div>

        {/* Money pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isMoney ? '' : 'hidden'}`}>
          <MoneyTab />
        </div>

        {/* Agents pane */}
        <div className={`flex flex-1 min-h-0 overflow-hidden ${isAgents ? '' : 'hidden'}`}>
          <AgentTab />
        </div>
      </div>

      {/* YouTube PiP overlay */}
      <YouTubePiP />

      {/* Pull-to-refresh indicator (mobile) */}
      {isMobile && <PullIndicator />}

      {/* Bottom bar: mobile tab bar or desktop footer */}
      {isMobile ? (
        <MobileTabBar
          activePane={activePane}
          setActivePane={setActivePane}
          gmailConnected={gmailConnected}
          matrixConnected={matrixConnected}
          setShowMatrixLogin={setShowMatrixLogin}
        />
      ) : (
        <Footer activePane={activePane} />
      )}
    </div>
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

  // Tabs with counts: Mail (inbox), Chat (unread rooms), Feeds (unread items), Agents (unread sessions)
  const count = pane === 'email'
    ? useInboxStore((s) => s.threads.length)
    : pane === 'chat'
      ? useChatStore((s) => s.rooms.filter((r) => r.isUnread).length)
      : pane === 'feeds'
        ? useFeedStore((s) => s.totalUnread)
        : pane === 'agents'
          ? useAgentStore((s) => s.sessions.filter((sess) => sess.hasUnread).length)
          : pane === 'notes'
            ? useNotesStore((s) => Object.values(s.openFiles).filter((f) => f.content !== f.savedContent).length)
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
        <span className="text-blue-500">({count})</span>
      )}
    </button>
  )
}

// ---------- Footer (isolates inbox/chat action callbacks) ----------

// ---------- MobileTabBar ----------

function MobileTabBar({ activePane, setActivePane, gmailConnected, matrixConnected, setShowMatrixLogin }: {
  activePane: ActivePane
  setActivePane: (p: ActivePane) => void
  gmailConnected: boolean
  matrixConnected: boolean
  setShowMatrixLogin: (v: boolean) => void
}) {
  const tabs: { pane: ActivePane; icon: ReactNode; label: string }[] = [
    { pane: 'home', icon: <LayoutDashboard size={18} />, label: 'Home' },
    { pane: 'email', icon: <Mail size={18} />, label: 'Mail' },
    { pane: 'calendar', icon: <CalendarDays size={18} />, label: 'Cal' },
    { pane: 'chat', icon: <MessageCircle size={18} />, label: 'Chat' },
    { pane: 'agents', icon: <Bot size={18} />, label: 'Agents' },
    { pane: 'feeds', icon: <Rss size={18} />, label: 'Feeds' },
    { pane: 'notes', icon: <FileText size={18} />, label: 'Notes' },
    { pane: 'bookmarks', icon: <Bookmark size={18} />, label: 'Marks' },
    { pane: 'money', icon: <PoundSterling size={18} />, label: 'Money' },
  ]

  return (
    <nav className="flex items-stretch border-t border-border bg-surface-0 overflow-x-auto">
      {tabs.map(({ pane, icon, label }) => {
        const isActive = activePane === pane

        const handleClick = () => {
          if (pane === 'chat' && !matrixConnected) {
            setShowMatrixLogin(true)
            return
          }
          if (isActive) {
            // Tap active tab again = back/deselect
            mobileGoBack(pane)
          }
          setActivePane(pane)
        }

        return (
          <MobileTabItem
            key={pane}
            pane={pane}
            icon={icon}
            label={!gmailConnected && pane === 'email' ? '+Mail' : !matrixConnected && pane === 'chat' ? '+Chat' : label}
            isActive={isActive}
            onClick={handleClick}
          />
        )
      })}
    </nav>
  )
}

function MobileTabItem({ pane, icon, label, isActive, onClick }: {
  pane: ActivePane
  icon: ReactNode
  label: string
  isActive: boolean
  onClick: () => void
}) {
  const count = pane === 'email'
    ? useInboxStore((s) => s.threads.length)
    : pane === 'chat'
      ? useChatStore((s) => s.rooms.filter((r) => r.isUnread).length)
      : pane === 'feeds'
        ? useFeedStore((s) => s.totalUnread)
        : pane === 'agents'
          ? useAgentStore((s) => s.sessions.filter((sess) => sess.hasUnread).length)
          : pane === 'notes'
            ? useNotesStore((s) => Object.values(s.openFiles).filter((f) => f.content !== f.savedContent).length)
            : 0

  return (
    <button
      onClick={onClick}
      className={`flex-1 min-w-0 flex flex-col items-center gap-0.5 py-1.5 text-[10px] transition-colors duration-fast relative ${
        isActive ? 'text-text-primary' : 'text-text-tertiary'
      }`}
    >
      <div className="relative">
        {icon}
        {count > 0 && (
          <span className="absolute -top-1 -right-2 min-w-[14px] h-3.5 flex items-center justify-center px-0.5 text-[9px] font-medium bg-blue-500 text-white rounded-full">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </div>
      <span className="truncate w-full text-center">{label}</span>
    </button>
  )
}

// ---------- Footer (desktop only) ----------

function Footer({ activePane }: { activePane: ActivePane }) {
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
    <footer className="flex items-center justify-between border-t border-border px-4 py-1">
      <div className="flex items-center gap-4">
        {isAgents || isBookmarks || isNotes || isCalendar || isMoney ? (
          <></>
        ) : isFeeds ? (
          <>
            <ActionHint keyLabel="e" action="Read" onClick={handleDone} />
            <ActionHint keyLabel="o" action="Open" onClick={() => useFeedStore.getState().openItemInBrowser()} />
          </>
        ) : (
          <>
            <ActionHint
              keyLabel="e"
              action={isEmail ? 'Done' : 'Read'}
              onClick={handleDone}
            />
            <ActionHint keyLabel="b" action="Snooze" onClick={() => setShowSnoozePicker(true)} />
            {isEmail && (
              <>
                <ActionHint keyLabel="r" action="Reply" />
                <ActionHint keyLabel="c" action="Compose" />
              </>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-text-tertiary">
        {isAgents ? (
          <>
            <span><kbd className="font-mono">e</kbd> read</span>
            <span><kbd className="font-mono">E</kbd> unread</span>
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
    </footer>
  )
}

// ---------- Mobile back navigation ----------

/** Deselect the current item in a pane, returning to the list view on mobile */
function mobileGoBack(pane: ActivePane) {
  switch (pane) {
    case 'email': useInboxStore.getState().selectThread(null); break
    case 'chat': useChatStore.getState().selectRoom(null); break
    case 'bookmarks': useBookmarkStore.getState().selectBookmark(null); break
    case 'notes': {
      const s = useNotesStore.getState()
      if (s.activeFilePath) s.closeFile(s.activeFilePath, true)
      break
    }
    case 'feeds': {
      const fs = useFeedStore.getState()
      if (fs.selectedItemId) { fs.selectItem(null) }
      else if (fs.selectedFeedId || fs.selectedFolderId) { useFeedStore.setState({ selectedFeedId: null, selectedFolderId: null }) }
      break
    }
    case 'money': useMoneyStore.getState().selectTransaction(null); break
    case 'agents': {
      const ag = useAgentStore.getState()
      if (ag.activeSessionId) ag.selectSession(null)
      // selectSession(null) sets creatingNewSession: true, so always clear it on back
      useAgentStore.setState({ creatingNewSession: false })
      break
    }
  }
}

/** Returns true if the pane has a selected item (detail view is showing) */
function useMobileHasSelection(pane: ActivePane): boolean {
  const threadId = useInboxStore((s) => s.selectedThreadId)
  const roomId = useChatStore((s) => s.selectedRoomId)
  const bookmarkId = useBookmarkStore((s) => s.selectedBookmarkId)
  const filePath = useNotesStore((s) => s.activeFilePath)
  const feedItemId = useFeedStore((s) => s.selectedItemId)
  const feedId = useFeedStore((s) => s.selectedFeedId)
  const folderId = useFeedStore((s) => s.selectedFolderId)
  const txId = useMoneyStore((s) => s.selectedTransactionId)
  const sessionId = useAgentStore((s) => s.activeSessionId)
  const creatingNewSession = useAgentStore((s) => s.creatingNewSession)

  switch (pane) {
    case 'email': return !!threadId
    case 'chat': return !!roomId
    case 'bookmarks': return !!bookmarkId
    case 'notes': return !!filePath
    case 'feeds': return !!(feedItemId || feedId || folderId)
    case 'money': return !!txId
    case 'agents': return !!sessionId || creatingNewSession
    default: return false
  }
}

function MobileBackButton({ activePane }: { activePane: ActivePane }) {
  const hasSelection = useMobileHasSelection(activePane)
  if (!hasSelection) return null

  return (
    <button
      onClick={() => mobileGoBack(activePane)}
      className="flex items-center text-text-secondary active:text-text-primary transition-colors duration-fast -ml-1 p-1"
    >
      <ChevronLeft size={18} />
    </button>
  )
}

// ---------- Helpers ----------

function MailConnectScreen() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleConnect = async () => {
    // Open popup synchronously in click handler to preserve user gesture
    const popup = window.open(
      `${getHubUrl()}/auth/google/start`,
      'google-auth',
      'width=500,height=600,menubar=no,toolbar=no',
    )
    setLoading(true)
    setError('')
    try {
      await gmailSignIn(popup)
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

function DndIndicator() {
  const dnd = useUiStore((s) => s.doNotDisturb)
  if (!dnd) return null
  return (
    <button
      onClick={() => useUiStore.getState().setDoNotDisturb(false)}
      className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
      title="Do Not Disturb is on — click to disable"
    >
      <BellOff size={12} />
    </button>
  )
}

// Shows when the hub WebSocket is closed — typically off-tailnet, but also
// fires when the hub process is restarting. Mutations still queue locally and
// flush on reconnect; this just lets the user know what they're looking at.
function HubOfflineIndicator() {
  const online = useUiStore((s) => s.hubOnline)
  if (online) return null
  return (
    <span
      className="inline-flex items-center text-text-tertiary"
      title="Hub unreachable — actions will queue and flush when it's back"
    >
      <CloudOff size={12} />
    </span>
  )
}

function ActionHint({ keyLabel, action, onClick }: { keyLabel: string; action: string; onClick?: () => void }) {
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
