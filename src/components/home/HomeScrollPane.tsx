import { useRef, type ReactNode } from 'react'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { useDashboardStore } from '@/store/dashboard'
import { useBlogStore } from '@/store/blog'

// Shared scroll wrapper for Home sub-tab cards. Pull-to-refresh on mobile
// re-pulls everything Home shows — snapshot, alerts, canvas meta, blog
// drafts/projects — in parallel. One gesture, regardless of which sub-tab
// is currently visible.
export function HomeScrollPane({
  children,
  className = 'flex-1 min-h-0 overflow-y-auto',
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  usePullToRefresh(ref, async () => {
    const d = useDashboardStore.getState()
    const b = useBlogStore.getState()
    await Promise.all([
      d.refreshSnapshot(),
      d.refreshAlerts(),
      d.refreshCanvasMeta(),
      b.refreshDrafts(),
      b.refreshProjects(),
    ])
  }, isMobile)
  return <div ref={ref} className={className}>{children}</div>
}
