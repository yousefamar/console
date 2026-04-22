import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore } from '@/store/agent'
import { AgentMessageBlock, renderMarkdownLite } from './AgentMessageBlock'
import { AgentToolApproval } from './AgentToolApproval'
import { AgentPromptInput } from './AgentPromptInput'
import { Loader2, GitBranch, ChevronDown } from 'lucide-react'

// ============================================================================
// AgentSessionView — renders the message stream for the active session,
// plus the status bar, tool approval overlay, and prompt input.
// ============================================================================

export function AgentSessionView() {
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  // Narrow subscription to only the active session's messages so unrelated sessions
  // don't trigger re-renders here. (Defense in depth against lag during typing.)
  const activeMessages = useAgentStore((s) => s.activeSessionId ? (s.messagesBySession[s.activeSessionId] ?? null) : null)
  const lastReadTs = useAgentStore((s) => s.activeSessionId ? (s.lastReadTsBySession[s.activeSessionId] ?? 0) : 0)
  const pendingApproval = useAgentStore((s) => s.pendingApproval)
  const activeSession = useAgentStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId))
  const isRunning = activeSession?.status === 'running'
  const statusText = activeSession?.statusText ?? null
  const sessionModel = activeSession?.model ?? null
  const permissionMode = activeSession?.permissionMode ?? null
  const sessionContextWindow = activeSession?.contextWindow ?? 200_000
  const sessionContextUsed = activeSession?.contextUsed ?? 0
  const pendingText = useAgentStore((s) => s.activeSessionId ? (s.pendingTextBySession[s.activeSessionId] ?? '') : '')
  const pendingThinking = useAgentStore((s) => s.activeSessionId ? (s.pendingThinkingBySession[s.activeSessionId] ?? '') : '')
  const activeSubagents = useAgentStore((s) => s.activeSessionId ? (s.activeSubagentsBySession[s.activeSessionId] ?? null) : null)
  const subagentCount = activeSubagents?.size ?? 0
  const hasOlder = useAgentStore((s) => s.activeSessionId ? (s.hasOlderBySession[s.activeSessionId] ?? false) : false)
  const loadingOlder = useAgentStore((s) => s.activeSessionId ? (s.loadingOlderBySession[s.activeSessionId] ?? false) : false)
  const loadOlderMessages = useAgentStore((s) => s.loadOlderMessages)
  const setTailing = useAgentStore((s) => s.setTailing)
  const connected = useAgentStore((s) => s.connected)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  /** Tracks whether user is near bottom — updated on every scroll event, read before auto-scroll */
  const isNearBottom = useRef(true)
  const messages = useMemo(() => activeMessages ?? [], [activeMessages])

  // Scroll to bottom on session switch
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      isNearBottom.current = true
      setShowScrollToBottom(false)
    }
    if (activeSessionId) setTailing(activeSessionId, true)
  }, [activeSessionId, setTailing])

  // Auto-scroll to bottom on new content — only if user was already near bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !isNearBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, pendingText, pendingThinking])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const el = scrollRef.current
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distFromBottom < 120
    isNearBottom.current = nearBottom
    setShowScrollToBottom(distFromBottom > 200)
    // Only tail (i.e. allow window-cap) when the user is near the bottom.
    if (activeSessionId) setTailing(activeSessionId, nearBottom)
    // Load older messages on scroll near top
    if (el.scrollTop < 100 && activeSessionId && hasOlder && !loadingOlder) {
      const prevHeight = el.scrollHeight
      loadOlderMessages(activeSessionId)
      // Preserve scroll position after prepend (defer to next frame)
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight
        }
      })
    }
  }, [activeSessionId, hasOlder, loadingOlder, loadOlderMessages, setTailing])

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-sm text-text-secondary">Agent Hub not connected</p>
        <p className="text-xs text-text-tertiary max-w-xs">
          Start the server to use agents:
        </p>
        <pre className="text-xs font-mono bg-surface-2 px-3 py-2 rounded-sm text-text-secondary">
          cd server && npm run dev
        </pre>
      </div>
    )
  }

  if (!activeSessionId) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-text-secondary">No active session</p>
            <p className="text-xs text-text-tertiary mt-1">
              Type a prompt below to start a new agent session
            </p>
          </div>
        </div>
        <AgentPromptInput />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Message stream */}
      <div className="flex-1 overflow-hidden relative min-w-0">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden py-2"
          onScroll={handleScroll}
        >
        {/* Loading older messages indicator */}
        {loadingOlder && (
          <div className="flex items-center justify-center py-2">
            <Loader2 size={12} className="animate-spin text-text-tertiary" />
            <span className="text-[10px] text-text-tertiary ml-1">Loading older messages...</span>
          </div>
        )}

        {messages.map((msg, i) => {
          // Skip standalone tool_result — it's rendered inside its tool_use block
          if (msg.block.type === 'tool_result') return null
          // Unread divider: show between last-read message and first new one
          const prevMsg = i > 0 ? messages[i - 1] : undefined
          const showUnreadDivider = lastReadTs > 0 &&
            prevMsg && prevMsg.timestamp <= lastReadTs &&
            msg.timestamp > lastReadTs &&
            msg.block.type !== 'user_prompt'
          // Pair tool_use with its following tool_result
          const toolResult = msg.block.type === 'tool_use'
            ? messages.slice(i + 1).find((m) => m.block.type === 'tool_result' && (m.block as { toolUseId: string }).toolUseId === (msg.block as { toolUseId: string }).toolUseId)
            : undefined
          return (
            <div key={msg.id}>
              {showUnreadDivider && (
                <div data-unread-divider className="flex items-center gap-3 px-3 my-2">
                  <div className="flex-1 border-t border-red-500/60" />
                  <span className="text-[10px] font-medium text-red-400 uppercase tracking-wider">New</span>
                  <div className="flex-1 border-t border-red-500/60" />
                </div>
              )}
              <AgentMessageBlock message={msg} toolResult={toolResult} />
            </div>
          )
        })}

        {/* Live streaming deltas */}
        {pendingThinking && (
          <div className="px-3 py-1">
            <div className="flex items-center gap-1 text-xs text-text-tertiary">
              <Loader2 size={11} className="animate-spin" />
              <span>Thinking...</span>
            </div>
            <div className="mt-1 ml-5 text-xs text-text-tertiary italic whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {pendingThinking}
            </div>
          </div>
        )}

        {pendingText && (
          <div className="px-3 py-1.5">
            <div className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed">
              {renderMarkdownLite(pendingText)}
              <span className="inline-block w-1.5 h-3.5 bg-text-tertiary ml-0.5 animate-pulse" />
            </div>
          </div>
        )}
        </div>
        {showScrollToBottom && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full bg-bg-tertiary border border-border p-1.5 shadow-md hover:bg-bg-secondary transition-opacity"
            title="Jump to bottom"
          >
            <ChevronDown size={16} className="text-text-secondary" />
          </button>
        )}
      </div>

      {/* Status bar */}
      {(isRunning || statusText || sessionModel || activeSession?.gitBranch || subagentCount > 0) && (
        <div className="flex items-center border-t border-border/50 px-3 py-1 gap-2 overflow-hidden min-w-0">
          {/* Model name + mode */}
          {sessionModel && (
            <span className="text-[10px] text-text-tertiary flex-shrink-0">
              {sessionModel}
            </span>
          )}
          {permissionMode && permissionMode !== 'default' && (
            <span className="text-[10px] text-warning font-medium flex-shrink-0">
              {permissionMode}
            </span>
          )}

          {/* Git branch */}
          {activeSession?.gitBranch && (
            <span className="text-[10px] text-text-tertiary flex-shrink min-w-0 truncate flex items-center gap-1">
              <GitBranch size={10} className="flex-shrink-0" />
              <span className="truncate">{activeSession.gitBranch}</span>
              {activeSession.gitStats && (activeSession.gitStats.added > 0 || activeSession.gitStats.deleted > 0) ? (
                <>
                  {activeSession.gitStats.added > 0 && <span className="text-green-400">+{activeSession.gitStats.added}</span>}
                  {activeSession.gitStats.deleted > 0 && <span className="text-red-400">-{activeSession.gitStats.deleted}</span>}
                </>
              ) : activeSession.gitDirty ? (
                <span className="text-yellow-400">*</span>
              ) : null}
            </span>
          )}

          {/* Context usage */}
          {sessionContextWindow > 0 && sessionModel && sessionContextUsed > 0 && (
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <div className="flex-1 h-[2px] bg-border/50 rounded-full overflow-hidden max-w-[120px]">
                <div
                  className={`h-full rounded-full transition-all duration-normal ${
                    sessionContextUsed / sessionContextWindow > 0.8 ? 'bg-red-400' :
                    sessionContextUsed / sessionContextWindow > 0.5 ? 'bg-yellow-400' :
                    'bg-text-tertiary'
                  }`}
                  style={{ width: `${Math.min(100, (sessionContextUsed / sessionContextWindow) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-text-tertiary flex-shrink-0" title={`${sessionContextUsed.toLocaleString()} / ${sessionContextWindow.toLocaleString()} tokens`}>
                {sessionContextUsed >= 1_000_000 ? `${(sessionContextUsed / 1_000_000).toFixed(1)}M` :
                 sessionContextUsed >= 1_000 ? `${Math.round(sessionContextUsed / 1_000)}k` :
                 sessionContextUsed}
                {' / '}
                {sessionContextWindow >= 1_000_000 ? `${(sessionContextWindow / 1_000_000).toFixed(0)}M` :
                 `${Math.round(sessionContextWindow / 1_000)}k`}
              </span>
            </div>
          )}

          {/* Active sub-agents */}
          {subagentCount > 0 && (
            <div className="flex items-center gap-1 text-[10px] text-warning flex-shrink-0" title={Array.from(activeSubagents!.values()).join(', ')}>
              <Loader2 size={9} className="animate-spin" />
              <span>{subagentCount} sub-agent{subagentCount > 1 ? 's' : ''}</span>
            </div>
          )}

          {/* Running status */}
          {(isRunning || statusText) && (
            <div className="flex items-center justify-end gap-1.5 text-[10px] text-text-tertiary min-w-0 flex-1 ml-auto">
              {isRunning && <Loader2 size={10} className="animate-spin flex-shrink-0" />}
              <span className="truncate min-w-0">{statusText ?? 'Processing...'}</span>
            </div>
          )}
        </div>
      )}

      {/* Tool approval */}
      {pendingApproval && pendingApproval.sessionId === activeSessionId && <AgentToolApproval approval={pendingApproval} />}

      {/* Prompt input */}
      <AgentPromptInput />
    </div>
  )
}