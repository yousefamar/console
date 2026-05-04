import { useEffect } from 'react'
import { Clock } from 'lucide-react'
import { useCronStore } from '@/store/cron'

interface Props {
  claudeSessionId: string | undefined
  onOpen: () => void
}

/**
 * Compact "cron: N" indicator for the agent session status bar.
 * Refreshes the per-session task list on mount and on session change.
 * Hidden when N=0.
 */
export function CronPill({ claudeSessionId, onOpen }: Props) {
  const tasks = useCronStore((s) => claudeSessionId ? (s.tasksBySession[claudeSessionId] ?? null) : null)
  const refresh = useCronStore((s) => s.refresh)

  useEffect(() => {
    if (!claudeSessionId) return
    refresh(claudeSessionId)
    // Light polling for cross-client mutations (CLI / mobile). 30s is plenty.
    const id = setInterval(() => refresh(claudeSessionId), 30_000)
    return () => clearInterval(id)
  }, [claudeSessionId, refresh])

  const active = (tasks ?? []).filter((t) => !t.disabledAt)
  if (active.length === 0) return null

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors duration-fast flex-shrink-0"
      title="Scheduled prompts for this session"
    >
      <Clock size={10} />
      <span>cron: {active.length}</span>
    </button>
  )
}
