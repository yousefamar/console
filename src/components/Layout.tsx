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
import { isMatrixConnected } from '@/matrix/auth'
import { db } from '@/db'
import { evictAll } from '@/utils/email-cache'
import { RefreshCw, Mail, MessageCircle, User, Bot } from 'lucide-react'
import { AgentTab } from './AgentTab'

export function Layout() {
  const threads = useInboxStore((s) => s.threads)
  const selectedThreadId = useInboxStore((s) => s.selectedThreadId)
  const selectThread = useInboxStore((s) => s.selectThread)
  const archiveThread = useInboxStore((s) => s.archiveThread)
  const snoozeThread = useInboxStore((s) => s.snoozeThread)

  const chatRooms = useChatStore((s) => s.rooms)
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const selectRoom = useChatStore((s) => s.selectRoom)
  const markRoomRead = useChatStore((s) => s.markRoomRead)

  const activePane = useUiStore((s) => s.activePane)
  const setActivePane = useUiStore((s) => s.setActivePane)
  const setShowSnoozePicker = useUiStore((s) => s.setShowSnoozePicker)
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const setShowAccountModal = useUiStore((s) => s.setShowAccountModal)
  const userEmail = useUiStore((s) => s.userEmail)
  const isMobile = useIsMobile()

  const matrixConnected = isMatrixConnected()

  const [showSnoozed, setShowSnoozed] = useState(false)
  const isEmail = activePane === 'email'
  const isChat = activePane === 'chat'
  const isAgents = activePane === 'agents'
  const showDetail = isMobile
    ? (isEmail ? !!selectedThreadId : !!selectedRoomId)
    : true
  const showList = isMobile
    ? (isEmail ? !selectedThreadId : !selectedRoomId)
    : true

  // Snoozed thread count
  const snoozedCount = useLiveQuery(
    () => db.threads.filter((t) => !!t.snoozedUntil).count(),
    [],
  )

  // Swipe refs for mobile
  const swipeContainerRef = useRef<HTMLDivElement>(null)
  const swipeContentRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeActions(swipeContainerRef, swipeContentRef, {
    onSwipeRight: () => isEmail ? archiveThread() : markRoomRead(),
    onSwipeLeft: () => isEmail ? snoozeThread('tomorrow') : undefined,
  })

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
          <h1
            className="text-sm font-semibold text-text-primary tracking-tight"
            onClick={isMobile && (selectedThreadId || selectedRoomId) ? () => {
              if (isEmail) selectThread(null)
              else selectRoom(null)
            } : undefined}
          >
            Console
          </h1>

          {/* Top-level pane tabs */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setActivePane('email')}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors duration-fast ${
                isEmail ? 'text-text-primary bg-surface-2' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <Mail size={11} />
              <span>Mail</span>
              {threads.length > 0 && (
                <span className="text-text-tertiary">({threads.length})</span>
              )}
            </button>
            {matrixConnected ? (
              <button
                onClick={() => setActivePane('chat')}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors duration-fast ${
                  isChat ? 'text-text-primary bg-surface-2' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                <MessageCircle size={11} />
                <span>Chat</span>
                {chatRooms.length > 0 && (
                  <span className="text-text-tertiary">({chatRooms.length})</span>
                )}
              </button>
            ) : (
              <button
                onClick={() => setShowMatrixLogin(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-text-tertiary hover:text-text-secondary rounded-sm transition-colors duration-fast"
              >
                <MessageCircle size={11} />
                <span>+Chat</span>
              </button>
            )}
            <button
              onClick={() => setActivePane('agents')}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors duration-fast ${
                isAgents ? 'text-text-primary bg-surface-2' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <Bot size={11} />
              <span>Agents</span>
            </button>
          </div>

          {!isMobile && userEmail && (
            <button
              onClick={() => setShowAccountModal(true)}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              title="Account settings"
            >
              {userEmail}
            </button>
          )}
          {isMobile && !(selectedThreadId || selectedRoomId) && (
            <button
              onClick={() => setShowAccountModal(true)}
              className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              title="Account"
            >
              <User size={13} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <SyncStatus />
          {!isAgents && (
            <button
              onClick={handleRefresh}
              className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              title="Refresh (Ctrl+click for full resync)"
            >
              <RefreshCw size={12} />
            </button>
          )}
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
        </div>

        {/* Chat pane */}
        <div className={`flex flex-1 min-h-0 ${isChat ? '' : 'hidden'}`}>
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
                  className="flex-1 min-h-0 flex flex-col relative"
                  onTouchStart={swipe.onTouchStart}
                  onTouchMove={swipe.onTouchMove}
                  onTouchEnd={swipe.onTouchEnd}
                >
                  <ChatRoomView />
                </div>
              ) : (
                <ChatRoomView />
              )}
            </div>
          )}
        </div>

        {/* Agents pane */}
        <div className={`flex flex-1 min-h-0 ${isAgents ? '' : 'hidden'}`}>
          <AgentTab />
        </div>
      </div>

      {/* Bottom action bar */}
      <footer className="flex items-center justify-between border-t border-border px-3 md:px-4 py-1 md:py-1">
        <div className="flex items-center gap-3 md:gap-4">
          {isAgents ? (
            <></>
          ) : (
            <>
              <ActionHint
                keyLabel="e"
                action={isEmail ? 'Done' : 'Read'}
                onClick={() => isEmail ? archiveThread() : markRoomRead()}
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
