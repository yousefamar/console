// Home pane renderer.
//
// Surfaces the same alerts the dashboard shows — pending agent approvals,
// upcoming events, recent errors — but on the lenses. If there are no
// alerts, falls back to a hub heartbeat line.

import { useDashboardStore } from '@/store/dashboard'
import { buildStatus, clipRow, type MirrorFrame, BODY_ROWS } from '../mirror'

export function renderHome(): MirrorFrame | null {
  const { alerts, snapshot } = useDashboardStore.getState()

  if (alerts.length === 0) {
    const sessions = snapshot?.hub.sessions ?? 0
    return {
      status: buildStatus(['Home', 'all clear']),
      body: [clipRow(`hub up · ${sessions} session${sessions === 1 ? '' : 's'}`)],
    }
  }

  const body = alerts.slice(0, BODY_ROWS).map((a) => {
    if (a.kind === 'agent-approval') {
      return clipRow(`? ${a.sessionName ?? 'agent'}: ${a.question ?? a.toolName}`)
    }
    if (a.kind === 'cal-upcoming') {
      const mins = Math.max(0, Math.round((a.startMs - Date.now()) / 60000))
      return clipRow(`@ ${mins}m ${a.summary}`)
    }
    return clipRow(`! ${a.message}`)
  })

  return {
    status: buildStatus(['Home', `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`]),
    body,
  }
}
