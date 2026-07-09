// Debug infrastructure — dev only
// Exposes stores, DB, and performance data on window.__console
// for browser console and MCP browser automation access.

import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import { useComposeStore } from '@/store/compose'
import { useBookmarkStore } from '@/store/bookmarks'
import { useAgentStore } from '@/store/agent'
import { useCalendarStore } from '@/store/calendar'
import { db } from '@/db'
import { hubBus as _hubBus } from '@/sync-bus'

interface LongTask {
  duration: number
  ts: number
}

interface PerfData {
  longTasks: LongTask[]
}

declare global {
  interface Window {
    __console: {
      stores: {
        inbox: typeof useInboxStore
        chat: typeof useChatStore
        notes: typeof useNotesStore
        ui: typeof useUiStore
        compose: typeof useComposeStore
        bookmarks: typeof useBookmarkStore
        agent: typeof useAgentStore
        calendar: typeof useCalendarStore
      }
      db: typeof db
      perf: PerfData
      hubBus: typeof _hubBus
    }
  }
}

const perf: PerfData = {
  longTasks: [],
}

// Expose everything on window
window.__console = {
  stores: {
    inbox: useInboxStore,
    chat: useChatStore,
    notes: useNotesStore,
    ui: useUiStore,
    compose: useComposeStore,
    bookmarks: useBookmarkStore,
    agent: useAgentStore,
    // The APP's instance. Debug-eval `import('/src/store/x.ts')` after HMR can
    // return a FRESH module copy with an empty store — always read via here.
    calendar: useCalendarStore,
  },
  db,
  perf,
  hubBus: _hubBus,
}

// Long task observer — logs any task blocking the main thread for >50ms
if ('PerformanceObserver' in window) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const task: LongTask = {
        duration: Math.round(entry.duration),
        ts: Math.round(entry.startTime),
      }
      perf.longTasks.push(task)
      // Keep last 200
      if (perf.longTasks.length > 200) perf.longTasks.shift()
      if (entry.duration > 100) {
        console.warn(`[perf] Long task: ${task.duration}ms`)
      }
    }
  })
  observer.observe({ entryTypes: ['longtask'] })
}

console.log('[debug] window.__console ready — stores, db, perf exposed')
