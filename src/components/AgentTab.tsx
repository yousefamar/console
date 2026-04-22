import { memo, useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useAgentStore } from '@/store/agent'
import { AgentSessionView } from './AgentSessionView'
import { ContextMenu } from './ContextMenu'
import { useIsMobile } from '@/hooks/useMediaQuery'
import clsx from 'clsx'
import { Circle, Plus } from 'lucide-react'
import type { SessionInfo } from '@/store/agent'
import type { ContextMenuItem } from './ContextMenu'

// ============================================================================
// AgentTab — top-level component for the Agents pane. Shows a session
// sidebar (desktop) and the active session view.
// ============================================================================

export const AgentTab = memo(function AgentTab() {
  const connected = useAgentStore((s) => s.connected)
  const connect = useAgentStore((s) => s.connect)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const selectSession = useAgentStore((s) => s.selectSession)
  const sessionOrder = useAgentStore((s) => s.sessionOrder)
  const reorderSession = useAgentStore((s) => s.reorderSession)
  const creatingNewSession = useAgentStore((s) => s.creatingNewSession)
  const isMobile = useIsMobile()

  // Separate Al from regular sessions — always pinned at top
  const alSession = sessions.find((s) => s.id === 'al')
  const activeSessions = sessions.filter((s) => s.status !== 'ended' && s.id !== 'al')

  // Auto-connect on mount
  useEffect(() => {
    connect()
    return () => {
      // Don't disconnect on unmount — keep connection alive across tab switches
    }
  }, [connect])

  const handleNewSession = useCallback(() => {
    selectSession(null)
    // Focus the prompt input
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-agent-input]')
      el?.focus()
    }, 50)
  }, [selectSession])

  const showList = isMobile ? (!activeSessionId && !creatingNewSession) : true
  const showDetail = isMobile ? (!!activeSessionId || creatingNewSession || !connected) : true

  return (
    <div className="flex flex-1 h-full min-w-0">
      {/* Session sidebar */}
      {showList && (
        <div className={`${isMobile ? 'w-full' : 'w-72'} flex-shrink-0 border-r border-border overflow-hidden flex flex-col`}>
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs font-medium text-text-primary">Sessions</span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleNewSession}
                className="text-text-tertiary hover:text-text-primary transition-colors duration-fast"
                title="New session"
              >
                <Plus size={12} />
              </button>
              <Circle
                size={6}
                className={clsx(
                  'fill-current',
                  connected ? 'text-success' : 'text-destructive',
                )}
              />
              <span className="text-[10px] text-text-tertiary">
                {connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* Al — pinned at top */}
            {alSession && <AlListItem session={alSession} isActive={alSession.id === activeSessionId} onSelect={selectSession} />}

            {activeSessions.length === 0 && !alSession && connected && (
              <div className="flex h-32 items-center justify-center">
                <p className="text-xs text-text-tertiary">No active sessions</p>
              </div>
            )}
            {orderedSessions(activeSessions, sessionOrder).map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={selectSession}
                onReorder={reorderSession}
              />
            ))}
          </div>
        </div>
      )}

      {/* Session view */}
      {showDetail && (
        <div className="flex-1 min-w-0 flex flex-col">
          <AgentSessionView />
        </div>
      )}
    </div>
  )
})

// --------------------------------------------------------------------------
// Session list item with context menu
// --------------------------------------------------------------------------

const SessionListItem = memo(function SessionListItem({ session, isActive, onSelect, onReorder }: {
  session: SessionInfo
  isActive: boolean
  onSelect: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
}) {
  const killSession = useAgentStore((s) => s.killSession)
  const forkSession = useAgentStore((s) => s.forkSession)
  const renameSession = useAgentStore((s) => s.renameSession)
  const generateTitleAction = useAgentStore((s) => s.generateTitle)
  const isGenerating = useAgentStore((s) => s.generatingTitleFor.has(session.id))
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const itemRef = useRef<HTMLButtonElement>(null)

  const displayName = session.name || session.prompt || session.id

  const startRename = useCallback(() => {
    setRenameValue(displayName)
    setIsRenaming(true)
    // Focus after render
    setTimeout(() => inputRef.current?.select(), 0)
  }, [displayName])

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== displayName) {
      renameSession(session.id, trimmed)
    }
    setIsRenaming(false)
  }, [renameValue, displayName, session.id, renameSession])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      { label: 'Rename', onClick: startRename },
      { label: 'Generate title', onClick: () => generateTitleAction(session.id) },
      { label: 'Fork', onClick: () => forkSession(session.id) },
    ]
    if (session.status !== 'ended') {
      items.push({
        label: 'End session',
        onClick: () => killSession(session.id),
        destructive: true,
      })
    }
    return items
  }, [session.status, session.id, killSession, startRename, generateTitleAction])

  return (
    <ContextMenu items={menuItems}>
      <button
        ref={itemRef}
        draggable={!isRenaming}
        onClick={() => onSelect(session.id)}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', session.id)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          const fromId = e.dataTransfer.getData('text/plain')
          if (fromId && fromId !== session.id) {
            onReorder(fromId, session.id)
          }
        }}
        onDragEnd={() => setIsDragOver(false)}
        onTouchStart={() => {
          longPressTimer.current = setTimeout(() => {
            if (itemRef.current) {
              itemRef.current.draggable = true
              itemRef.current.style.opacity = '0.5'
            }
          }, 500)
        }}
        onTouchEnd={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current)
          if (itemRef.current) {
            itemRef.current.style.opacity = ''
          }
        }}
        className={clsx(
          'w-full text-left px-3 py-2 border-b transition-colors duration-fast',
          isDragOver ? 'border-t-2 border-t-text-primary border-b-border' : 'border-b-border',
          isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
        )}
      >
        {isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setIsRenaming(false)
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs font-medium bg-surface-1 border border-border rounded px-1 py-0.5 text-text-primary outline-none"
            autoFocus
          />
        ) : (
          <div className="flex items-center justify-between">
            <span className={clsx(
              'text-xs truncate max-w-[200px]',
              isGenerating ? 'text-text-tertiary italic font-medium' :
              session.hasUnread ? 'text-text-primary font-semibold' : 'text-text-primary font-medium',
            )}>
              {isGenerating ? 'Generating title…' : displayName}
            </span>
            <div className="flex items-center gap-1.5">
              {session.hasUnread && !isActive && (
                <Circle size={5} className="fill-current text-blue-500 flex-shrink-0" />
              )}
              <StatusDot status={session.status} />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-text-tertiary">
          <span>{formatTime(session.createdAt)}</span>
          {session.cwd && (
            <span className="truncate max-w-[100px]">{dirBasename(session.cwd)}</span>
          )}
        </div>
      </button>
    </ContextMenu>
  )
})

// --------------------------------------------------------------------------
// Al pinned entry
// --------------------------------------------------------------------------

const AlListItem = memo(function AlListItem({ session, isActive, onSelect }: {
  session: SessionInfo
  isActive: boolean
  onSelect: (id: string) => void
}) {
  // Extract last text preview directly from store (stable selector — no new array)
  const lastText = useAgentStore((s) => {
    const msgs = s.messagesBySession[session.id]
    if (!msgs) return null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const block = msgs[i]!.block
      if (block.type === 'text') return block.content.slice(0, 80)
      if (block.type === 'user_prompt') return block.content.slice(0, 80)
    }
    return null
  })

  return (
    <button
      onClick={() => onSelect(session.id)}
      className={clsx(
        'w-full text-left px-3 py-2 border-b border-border transition-colors duration-fast',
        isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">Al</span>
        <StatusDot status={session.status} />
      </div>
      {lastText && (
        <div className="text-[10px] text-text-tertiary truncate mt-0.5 max-w-[200px]">
          {lastText.slice(0, 80)}
        </div>
      )}
    </button>
  )
})

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function StatusDot({ status }: { status: 'running' | 'idle' | 'ended' }) {
  return (
    <Circle
      size={6}
      className={clsx(
        'fill-current flex-shrink-0',
        status === 'running' && 'text-warning',
        status === 'idle' && 'text-success',
        status === 'ended' && 'text-text-tertiary',
      )}
    />
  )
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dirBasename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** Order sessions by custom order (if set), falling back to createdAt desc */
function orderedSessions<T extends { id: string; status: string; createdAt: number }>(sessions: T[], order: string[]): T[] {
  if (order.length === 0) {
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt)
  }
  const orderMap = new Map(order.map((id, i) => [id, i]))
  return [...sessions].sort((a, b) => {
    const aIdx = orderMap.get(a.id) ?? Infinity
    const bIdx = orderMap.get(b.id) ?? Infinity
    if (aIdx !== Infinity || bIdx !== Infinity) return aIdx - bIdx
    return b.createdAt - a.createdAt
  })
}

