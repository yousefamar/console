import { CalendarClock, ShieldQuestion, AlertTriangle } from 'lucide-react'
import { useDashboardStore, type DashboardAlert } from '@/store/dashboard'
import { useUiStore } from '@/store/ui'
import { useAgentStore } from '@/store/agent'
import { HomeScrollPane } from './HomeScrollPane'

export function AlertsCard() {
  const alerts = useDashboardStore((s) => s.alerts)
  const loading = useDashboardStore((s) => s.alertsLoading)

  return (
    <section className="flex flex-col h-full min-h-0 border border-border rounded-sm bg-surface-1 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Alerts</h2>
        <span className="text-[10px] text-text-tertiary">{alerts.length}</span>
      </header>
      <HomeScrollPane>
        {alerts.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-tertiary">{loading ? 'Loading…' : 'Nothing pressing.'}</div>
        )}
        <ul className="divide-y divide-border">
          {alerts.map((a, i) => <Item key={`${a.kind}-${i}`} alert={a} />)}
        </ul>
      </HomeScrollPane>
    </section>
  )
}

function Item({ alert }: { alert: DashboardAlert }) {
  if (alert.kind === 'agent-approval') {
    return (
      <li
        onClick={() => {
          useUiStore.getState().setActivePane('agents')
          useAgentStore.getState().selectSession(alert.sessionId)
        }}
        className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
        role="button"
      >
        <ShieldQuestion size={12} className="text-yellow-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-primary truncate">
            {alert.toolName === 'AskUserQuestion' ? 'Agent needs your input' : 'Agent needs approval'}
          </div>
          <div className="text-[10px] text-text-tertiary truncate">
            {alert.sessionName ?? alert.sessionId.slice(0, 12)} · {alert.question ?? alert.toolName}
          </div>
        </div>
      </li>
    )
  }
  if (alert.kind === 'cal-upcoming') {
    return (
      <li
        onClick={() => useUiStore.getState().setActivePane('calendar')}
        className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer"
        role="button"
      >
        <CalendarClock size={12} className="text-blue-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-primary truncate">{alert.summary}</div>
          <div className="text-[10px] text-text-tertiary truncate">
            in {fmtMinutes(alert.startMs - Date.now())}
          </div>
        </div>
      </li>
    )
  }
  // error
  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <AlertTriangle size={12} className="text-red-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate">{alert.message}</div>
        <div className="text-[10px] text-text-tertiary truncate">
          {alert.source} · {fmtAgo(Date.now() - alert.ts)}
        </div>
      </div>
    </li>
  )
}

function fmtMinutes(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

function fmtAgo(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
