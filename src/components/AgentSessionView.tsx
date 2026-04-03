import { useEffect, useMemo, useRef } from 'react'
import { useAgentStore } from '@/store/agent'
import { AgentMessageBlock, renderMarkdownLite } from './AgentMessageBlock'
import { AgentToolApproval } from './AgentToolApproval'
import { AgentPromptInput } from './AgentPromptInput'
import { Loader2 } from 'lucide-react'

// ============================================================================
// AgentSessionView — renders the message stream for the active session,
// plus the status bar, tool approval overlay, and prompt input.
// ============================================================================

export function AgentSessionView() {
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const messagesBySession = useAgentStore((s) => s.messagesBySession)
  const pendingApproval = useAgentStore((s) => s.pendingApproval)
  const activeSession = useAgentStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId))
  const isRunning = activeSession?.status === 'running'
  const statusText = activeSession?.statusText ?? null
  const sessionModel = activeSession?.model ?? null
  const sessionContextWindow = activeSession?.contextWindow ?? 200_000
  const sessionContextUsed = activeSession?.contextUsed ?? 0
  const pendingText = useAgentStore((s) => s.activeSessionId ? (s.pendingTextBySession[s.activeSessionId] ?? '') : '')
  const pendingThinking = useAgentStore((s) => s.activeSessionId ? (s.pendingThinkingBySession[s.activeSessionId] ?? '') : '')
  const connected = useAgentStore((s) => s.connected)

  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = useMemo(
    () => activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [],
    [activeSessionId, messagesBySession],
  )

  // Track whether user has scrolled away from bottom
  const userScrolledUp = useRef(false)

  // Detect manual scroll-away
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !nearBottom
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Scroll to bottom on session switch
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      userScrolledUp.current = false
    }
  }, [activeSessionId])

  // Auto-scroll to bottom on new content (unless user scrolled up)
  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, pendingText, pendingThinking])

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
    <div className="flex flex-1 flex-col min-h-0">
      {/* Message stream */}
      <div className="flex-1 overflow-hidden relative">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto py-2"
        >
        {messages.map((msg, i) => {
          // Skip standalone tool_result — it's rendered inside its tool_use block
          if (msg.block.type === 'tool_result') return null
          // Pair tool_use with its following tool_result
          const toolResult = msg.block.type === 'tool_use'
            ? messages.slice(i + 1).find((m) => m.block.type === 'tool_result' && (m.block as { toolUseId: string }).toolUseId === (msg.block as { toolUseId: string }).toolUseId)
            : undefined
          return <AgentMessageBlock key={msg.id} message={msg} toolResult={toolResult} />
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
      </div>

      {/* Status bar */}
      {(isRunning || statusText || sessionModel) && (
        <div className="flex items-center border-t border-border/50 px-3 py-1 gap-3">
          {/* Model name */}
          {sessionModel && (
            <span className="text-[10px] text-text-tertiary flex-shrink-0">
              {sessionModel}
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

          {/* Running status */}
          {(isRunning || statusText) && (
            <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary min-w-0 flex-shrink-0 ml-auto">
              {isRunning && <Loader2 size={10} className="animate-spin flex-shrink-0" />}
              <span className="truncate max-w-[200px]">{statusText ?? 'Processing...'}</span>
            </div>
          )}
        </div>
      )}

      {/* Tool approval */}
      {pendingApproval && <AgentToolApproval approval={pendingApproval} />}

      {/* Prompt input */}
      <AgentPromptInput />
    </div>
  )
}