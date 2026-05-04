import { memo, useEffect, useState } from 'react'
import { useDashboardStore, wireDashboardBus } from '@/store/dashboard'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { ServersCard } from './home/ServersCard'
import { AlertsCard } from './home/AlertsCard'
import { AgentCanvasCard } from './home/AgentCanvasCard'
import { BlogDraftsCard } from './home/BlogDraftsCard'
import { ProjectsCard } from './home/ProjectsCard'

const SNAPSHOT_INTERVAL_MS = 30_000
const ALERTS_INTERVAL_MS = 15_000
const SUBTAB_KEY = 'console:home:subtab'

type SubTab = 'alerts' | 'servers' | 'canvas' | 'blog'

function loadSubTab(): SubTab {
  if (typeof localStorage === 'undefined') return 'alerts'
  const v = localStorage.getItem(SUBTAB_KEY)
  return v === 'servers' || v === 'canvas' || v === 'blog' ? v : 'alerts'
}

export const HomeTab = memo(function HomeTab() {
  const refreshSnapshot = useDashboardStore((s) => s.refreshSnapshot)
  const refreshAlerts = useDashboardStore((s) => s.refreshAlerts)
  const refreshCanvasMeta = useDashboardStore((s) => s.refreshCanvasMeta)
  const isMobile = useIsMobile()
  const [subTab, setSubTab] = useState<SubTab>(loadSubTab)

  useEffect(() => { localStorage.setItem(SUBTAB_KEY, subTab) }, [subTab])

  useEffect(() => {
    wireDashboardBus()
    void refreshSnapshot()
    void refreshAlerts()
    void refreshCanvasMeta()
    const t1 = setInterval(() => { void refreshSnapshot() }, SNAPSHOT_INTERVAL_MS)
    const t2 = setInterval(() => { void refreshAlerts() }, ALERTS_INTERVAL_MS)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [refreshSnapshot, refreshAlerts, refreshCanvasMeta])

  // Mobile: one section at a time, full viewport. Avoids scroll-fighting
  // with the canvas iframe (sandbox=allow-scripts captures touch events).
  // Desktop: classic 3-up grid.
  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <SubTabBar value={subTab} onChange={setSubTab} />
        <div className="flex flex-1 min-h-0 p-2">
          <div className={`flex-1 min-h-0 ${subTab === 'alerts' ? '' : 'hidden'}`}>
            <AlertsCard />
          </div>
          <div className={`flex-1 min-h-0 ${subTab === 'servers' ? '' : 'hidden'}`}>
            <ServersCard />
          </div>
          <div className={`flex-1 min-h-0 ${subTab === 'canvas' ? '' : 'hidden'}`}>
            <AgentCanvasCard />
          </div>
          <div className={`flex-1 min-h-0 ${subTab === 'blog' ? 'flex flex-col gap-2' : 'hidden'}`}>
            <div className="flex-1 min-h-0"><BlogDraftsCard /></div>
            <div className="flex-1 min-h-0"><ProjectsCard /></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col p-3 gap-3 overflow-hidden">
      <div className="grid grid-cols-4 gap-3 flex-[4] min-h-0">
        <AlertsCard />
        <ServersCard />
        <BlogDraftsCard />
        <ProjectsCard />
      </div>
      <div className="flex-[5] min-h-0">
        <AgentCanvasCard />
      </div>
    </div>
  )
})

function SubTabBar({ value, onChange }: { value: SubTab; onChange: (v: SubTab) => void }) {
  const alertsCount = useDashboardStore((s) => s.alerts.length)
  const tabs: Array<{ id: SubTab; label: string; badge?: number }> = [
    { id: 'alerts', label: 'Alerts', badge: alertsCount },
    { id: 'servers', label: 'Servers' },
    { id: 'blog', label: 'Blog' },
    { id: 'canvas', label: 'Canvas' },
  ]
  return (
    <div className="flex border-b border-border bg-surface-1 shrink-0">
      {tabs.map((t) => {
        const active = value === t.id
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs uppercase tracking-wide transition-colors ${
              active
                ? 'text-text-primary border-b-2 border-blue-500'
                : 'text-text-tertiary border-b-2 border-transparent'
            }`}
          >
            <span>{t.label}</span>
            {t.badge ? (
              <span className="text-[9px] font-medium bg-blue-500 text-white rounded-full px-1.5 py-0.5">{t.badge}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
