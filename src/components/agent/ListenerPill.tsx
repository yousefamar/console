import { useEffect } from 'react'
import { Radio } from 'lucide-react'
import { useListenersStore } from '@/store/listeners'

interface Props {
  claudeSessionId: string | undefined
  onOpen: () => void
}

/** "listen: N" chip for the session status bar — the CronPill's twin. Hidden when N=0. */
export function ListenerPill({ claudeSessionId, onOpen }: Props) {
  const listeners = useListenersStore((s) => claudeSessionId ? (s.bySession[claudeSessionId] ?? null) : null)
  const refresh = useListenersStore((s) => s.refresh)

  useEffect(() => {
    if (!claudeSessionId) return
    refresh(claudeSessionId)
    const id = setInterval(() => refresh(claudeSessionId), 30_000)
    return () => clearInterval(id)
  }, [claudeSessionId, refresh])

  const active = (listeners ?? []).filter((l) => !l.disabledAt)
  if (active.length === 0) return null
  const paused = active.filter((l) => l.pausedAt).length

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors duration-fast flex-shrink-0"
      title="Event listeners for this session"
    >
      <Radio size={10} />
      <span>listen: {active.length}{paused ? <span className="text-yellow-400"> ({paused} paused)</span> : null}</span>
    </button>
  )
}
