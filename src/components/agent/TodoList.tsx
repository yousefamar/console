import { Check, Circle, Loader2 } from 'lucide-react'
import type { TodoItem } from '@/store/agent'

// ============================================================================
// Shared task-list rendering. Two shapes feed it:
//   - live: SessionInfo.todos, read hub-side off the CLI's ~/.claude/tasks store
//     (TaskCreate/TaskUpdate are incremental, so no single call has the list)
//   - historical: a legacy TodoWrite tool_use block's `input.todos`
// Legacy items key the label off `content`; the new ones off `subject`.
// ============================================================================

export function todoLabel(t: TodoItem): string {
  return t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject
}

export function todoProgress(todos: TodoItem[]): { done: number; total: number; current?: TodoItem } {
  return {
    done: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
    current: todos.find((t) => t.status === 'in_progress'),
  }
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="space-y-0.5 ml-1">
      {todos.map((t) => {
        const cls = t.status === 'completed'
          ? 'text-text-tertiary line-through'
          : t.status === 'in_progress'
            ? 'text-text-primary font-medium'
            : 'text-text-secondary'
        return (
          <li key={t.id} className="flex items-start gap-1.5 text-xs leading-relaxed">
            <span className="mt-0.5 flex-shrink-0">
              {t.status === 'completed'
                ? <Check size={11} className="text-success" />
                : t.status === 'in_progress'
                  ? <Loader2 size={11} className="text-warning animate-spin" />
                  : <Circle size={11} className="text-text-tertiary" />}
            </span>
            <span className={`flex-1 min-w-0 break-words ${cls}`} title={t.description || undefined}>{todoLabel(t)}</span>
          </li>
        )
      })}
    </ul>
  )
}
