import { useMemo } from 'react'
import { X, ArrowRight, Play, Ban } from 'lucide-react'
import { useAgentStore, type AgentTask } from '@/store/agent'

// Delegation tasks — what's in flight across the org. Open tasks on top, a few
// recent terminal ones below. Jump to an assignee's session or cancel a task.
export function TasksPanel({ onClose }: { onClose: () => void }) {
  const tasks = useAgentStore((s) => s.tasks)
  const roles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const cancelTask = useAgentStore((s) => s.cancelTask)
  const selectSession = useAgentStore((s) => s.selectSession)

  const titleFor = (k: string) => roles.find((r) => r.key === k)?.title ?? k
  const isOpen = (t: AgentTask) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked'
  const open = useMemo(() => tasks.filter(isOpen).sort((a, b) => b.updatedAt - a.updatedAt), [tasks])
  const recent = useMemo(() => tasks.filter((t) => !isOpen(t)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8), [tasks])

  const openAssignee = (key: string) => {
    const live = sessions.find((s) => s.agentKey === key && s.status !== 'ended')
    if (live) selectSession(live.id)
  }

  return (
    <div className="flex h-full w-full flex-col bg-surface-1">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border bg-surface-2 px-3 py-2">
        <span className="text-xs font-medium text-text-primary">Delegation tasks {open.length > 0 && <span className="text-text-tertiary">· {open.length} open</span>}</span>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {open.length === 0 && recent.length === 0 && (
          <div className="flex h-24 items-center justify-center text-xs text-text-tertiary">No tasks yet</div>
        )}
        {open.map((t) => <TaskRow key={t.id} t={t} titleFor={titleFor} onOpen={openAssignee} onCancel={() => cancelTask(t.id)} />)}
        {recent.length > 0 && open.length > 0 && <div className="px-1 pt-2 text-[10px] uppercase tracking-wider text-text-tertiary">Recent</div>}
        {recent.map((t) => <TaskRow key={t.id} t={t} titleFor={titleFor} onOpen={openAssignee} />)}
      </div>
    </div>
  )
}

const STATUS_STYLE: Record<AgentTask['status'], string> = {
  pending: 'text-text-tertiary',
  in_progress: 'text-amber-400',
  blocked: 'text-red-400',
  done: 'text-green-500',
  failed: 'text-red-500',
  cancelled: 'text-text-tertiary line-through',
}

function TaskRow({ t, titleFor, onOpen, onCancel }: {
  t: AgentTask
  titleFor: (k: string) => string
  onOpen: (key: string) => void
  onCancel?: () => void
}) {
  const chain = (t.origin === 'human' ? ['Yousef', ...t.chain.map(titleFor)] : t.chain.map(titleFor)).join(' → ')
  return (
    <div className="rounded border border-border bg-surface-2 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-text-primary">{t.title}</span>
        <span className={`flex-shrink-0 text-[10px] font-medium ${STATUS_STYLE[t.status]}`}>{t.status.replace('_', ' ')}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-text-tertiary">
        <span className="truncate">{titleFor(t.fromKey)}</span>
        <ArrowRight size={9} className="flex-shrink-0" />
        <button onClick={() => onOpen(t.toKey)} className="truncate text-text-secondary hover:text-text-primary hover:underline" title="Open assignee session">{titleFor(t.toKey)}</button>
      </div>
      {t.result && <div className="mt-1 line-clamp-2 text-[10px] text-text-tertiary">{t.result}</div>}
      <div className="mt-1 flex items-center justify-between">
        <span className="truncate text-[9px] text-text-tertiary" title={chain}>{chain}</span>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button onClick={() => onOpen(t.toKey)} className="flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-text-primary"><Play size={9} />open</button>
          {onCancel && <button onClick={onCancel} className="flex items-center gap-0.5 text-[10px] text-red-400/70 hover:text-red-400"><Ban size={9} />cancel</button>}
        </div>
      </div>
    </div>
  )
}
