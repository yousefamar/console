// ============================================================================
// ICS feed for the hub's cron schedule.
//
// Each scheduled task is expanded into discrete VEVENTs (next ~50 firings over
// the next 30 days) — avoids the lossy cron→RRULE conversion that would be
// required for a single recurring VEVENT. Calendar clients refresh the
// snapshot periodically.
//
// Uses `ical-generator` for RFC5545 escaping, line folding, and timezone
// handling — hand-rolled was buggy on UTF-8 line folding.
// ============================================================================

import ical from 'ical-generator'
import type { HubCronTask } from './scheduler.js'

interface UpcomingFires {
  task: HubCronTask
  fires: Date[]
}

interface SessionLookup {
  /** Resolve a claudeSessionId to a human-friendly session name (or fallback). */
  nameFor(claudeSessionId: string): string
}

export function buildIcs(upcoming: UpcomingFires[], lookup: SessionLookup): string {
  const cal = ical({
    name: 'Console agent cron',
    description: 'Scheduled prompts firing into Console agent sessions',
    prodId: { company: 'console', product: 'hub-cron', language: 'EN' },
    method: 'PUBLISH' as never, // ical-generator's enum import is awkward; string works
  })

  for (const { task, fires } of upcoming) {
    const sessionName = lookup.nameFor(task.claudeSessionId)
    const summary = `[${sessionName}] ${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? '…' : ''}`
    const description =
      `Cron: ${task.trigger}\n` +
      `Prompt: ${task.prompt}\n` +
      `Session: ${sessionName} (${task.claudeSessionId})`
    for (const fire of fires) {
      cal.createEvent({
        id: `${task.id}-${fire.toISOString()}`,
        start: fire,
        end: new Date(fire.getTime() + 60_000), // 1-minute placeholder duration
        summary,
        description,
        categories: [{ name: task.recurring ? 'recurring' : 'one-shot' }],
      })
    }
  }

  return cal.toString()
}
