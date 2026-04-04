import { useEffect, useMemo } from 'react'
import { useAgentStore } from '@/store/agent'
import { AgentSessionView } from './AgentSessionView'
import { ContextMenu } from './ContextMenu'
import { useIsMobile } from '@/hooks/useMediaQuery'
import clsx from 'clsx'
import { Bot, Circle, Plus } from 'lucide-react'
import type { SessionInfo } from '@/store/agent'
import type { ContextMenuItem } from './ContextMenu'

// ============================================================================
// AgentTab — top-level component for the Agents pane. Shows a session
// sidebar (desktop) and the active session view.
// ============================================================================

export function AgentTab() {
  const connected = useAgentStore((s) => s.connected)
  const connect = useAgentStore((s) => s.connect)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const selectSession = useAgentStore((s) => s.selectSession)
  const isMobile = useIsMobile()

  // Separate Al from regular sessions
  const alSession = sessions.find((s) => s.isAl)
  const activeSessions = sessions.filter((s) => s.status !== 'ended' && !s.isAl)

  // Auto-connect on mount
  useEffect(() => {
    connect()
    return () => {
      // Don't disconnect on unmount — keep connection alive across tab switches
    }
  }, [connect])

  // On mobile, show only the session view (no sidebar)
  if (isMobile) {
    return <AgentSessionView />
  }

  return (
    <div className="flex flex-1 h-full">
      {/* Session sidebar */}
      <div className="w-72 flex-shrink-0 border-r border-border overflow-hidden flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs font-medium text-text-primary">Sessions</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => useAgentStore.getState().selectSession(null)}
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
          {alSession && (
            <button
              onClick={() => selectSession(alSession.id)}
              className={clsx(
                'w-full text-left px-3 py-2 border-b border-border transition-colors duration-fast flex items-center gap-2',
                alSession.id === activeSessionId ? 'bg-surface-2' : 'hover:bg-surface-1',
              )}
            >
              <Bot size={14} className="text-accent flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-primary">Al</span>
                  <StatusDot status={alSession.status} />
                </div>
                <span className="text-[10px] text-text-tertiary">
                  {alSession.status === 'running' ? 'Thinking...' : 'Assistant'}
                </span>
              </div>
            </button>
          )}

          {activeSessions.length === 0 && !alSession && connected && (
            <div className="flex h-32 items-center justify-center">
              <p className="text-xs text-text-tertiary">No active sessions</p>
            </div>
          )}
          {sortedSessions(activeSessions).map((session) => (
            <SessionListItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onSelect={() => selectSession(session.id)}
            />
          ))}
        </div>
      </div>

      {/* Session view */}
      <div className="flex-1 min-w-0 flex flex-col">
        <AgentSessionView />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Session list item with context menu
// --------------------------------------------------------------------------

function SessionListItem({ session, isActive, onSelect }: {
  session: SessionInfo
  isActive: boolean
  onSelect: () => void
}) {
  const killSession = useAgentStore((s) => s.killSession)

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = []
    if (session.status !== 'ended') {
      items.push({
        label: 'End session',
        onClick: () => killSession(session.id),
        destructive: true,
      })
    }
    return items
  }, [session.status, session.id, killSession])

  return (
    <ContextMenu items={menuItems}>
      <button
        onClick={onSelect}
        className={clsx(
          'w-full text-left px-3 py-2 border-b border-border transition-colors duration-fast',
          isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-primary truncate max-w-[200px]">
            {session.prompt || session.id}
          </span>
          <StatusDot status={session.status} />
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-text-tertiary">
          <span>{formatTime(session.createdAt)}</span>
          {session.cwd && (
            <span className="truncate max-w-[100px]">{dirBasename(session.cwd)}</span>
          )}
        </div>
      </button>
    </ContextMenu>
  )
}

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

/** Sort sessions: active (running/idle) first by createdAt desc, then ended by createdAt desc */
function sortedSessions<T extends { status: string; createdAt: number }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const aActive = a.status !== 'ended' ? 0 : 1
    const bActive = b.status !== 'ended' ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return b.createdAt - a.createdAt
  })
}
