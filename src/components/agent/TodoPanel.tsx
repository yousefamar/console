import { useEffect, useState } from 'react'
import { ListTodo, ChevronDown, ChevronUp } from 'lucide-react'
import { useAgentStore } from '@/store/agent'
import { TodoList, todoLabel, todoProgress } from './TodoList'

// ============================================================================
// TodoPanel — the active session's live task list, pinned above the composer.
//
// Replaces the old inline TodoWrite block as the primary surface: the CLI now
// mutates tasks one at a time (TaskCreate / TaskUpdate), so there's no single
// stream message holding the list to render inline. The hub reads the CLI's own
// ~/.claude/tasks/<claudeSessionId>/ store and pushes it as SessionInfo.todos.
//
// Collapsed by default once everything's done — a finished list is history, and
// the header still shows N/N. `collapsed` is a nullable OVERRIDE, not a plain
// boolean: with `collapsed || allDone` a completed list could never be opened
// (the click just wrote true over a value already forced true).
// ============================================================================

export function TodoPanel() {
  const sessionId = useAgentStore((s) => s.activeSessionId)
  const todos = useAgentStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId)?.todos)
  const [collapsed, setCollapsed] = useState<boolean | null>(null)

  // The override is per-session — switching sessions falls back to the default.
  useEffect(() => setCollapsed(null), [sessionId])

  if (!todos?.length) return null
  const { done, total, current } = todoProgress(todos)
  const allDone = done === total
  const isCollapsed = collapsed ?? allDone

  return (
    <div className="border-t border-border bg-surface-1 flex-shrink-0">
      <button
        onClick={() => setCollapsed(!isCollapsed)}
        aria-expanded={!isCollapsed}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-2 transition-colors"
      >
        <ListTodo size={11} className="flex-shrink-0" />
        <span className="font-medium flex-shrink-0">Tasks</span>
        <span className="text-text-tertiary flex-shrink-0">{done}/{total}</span>
        {current
          ? <span className="text-text-tertiary truncate min-w-0 text-left" title={todoLabel(current)}>· {todoLabel(current)}</span>
          : <span className="min-w-0 flex-1" />}
        {isCollapsed
          ? <ChevronUp size={11} className="flex-shrink-0 ml-auto text-text-tertiary" />
          : <ChevronDown size={11} className="flex-shrink-0 ml-auto text-text-tertiary" />}
      </button>
      {!isCollapsed && (
        <div className="px-3 pb-1.5 max-h-[30vh] overflow-y-auto">
          <TodoList todos={todos} />
        </div>
      )}
    </div>
  )
}
