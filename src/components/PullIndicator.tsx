import { memo } from 'react'
import { RefreshCw, ArrowDown } from 'lucide-react'
import { usePullStore, PULL_THRESHOLD } from '@/store/pull'

// Single global indicator driven by the pull store. Mounted once in Layout.
// Stays out of the way (top center, fixed) and only renders when actively
// pulling or refreshing — zero impact on idle interaction.
export const PullIndicator = memo(function PullIndicator() {
  const distance = usePullStore((s) => s.distance)
  const refreshing = usePullStore((s) => s.refreshing)

  const visible = distance > 0 || refreshing
  if (!visible) return null

  const translateY = refreshing ? 36 : Math.min(distance, 90)
  const triggered = distance >= PULL_THRESHOLD

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-0 z-[60] flex items-center justify-center"
      style={{
        transform: `translate(-50%, ${translateY}px)`,
        transition: refreshing ? 'transform 200ms ease-out' : 'none',
      }}
    >
      <div className="rounded-full bg-surface-2 border border-border shadow-md p-2">
        {refreshing ? (
          <RefreshCw size={18} className="animate-spin text-accent" />
        ) : (
          <ArrowDown
            size={18}
            className={`transition-transform duration-fast ${triggered ? 'rotate-180 text-accent' : 'text-text-secondary'}`}
          />
        )}
      </div>
    </div>
  )
})
