// Boot wiring for the unified Inbox pane — lives here (called from
// GatedBoot), NOT in InboxTab's mount effect: the tab-bar unread badge needs
// the composed lists live from boot, and InboxTab only mounts while active
// (the ^deft-ant lesson — never let a lazily-mounted component own de-facto
// boot wiring).

import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useFeedStore } from '@/store/feeds'
import { useAgentStore } from '@/store/agent'
import { useSpacesStore } from '@/store/spaces'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { makeRebuildScheduler } from '@/inbox/rebuild-scheduler'

const REBUILD_DEBOUNCE_MS = 300
/** Ceiling on how long a busy fleet's store writes can hold a rebuild off
 *  (each write resets the debounce; see rebuild-scheduler.ts). */
const REBUILD_MAX_WAIT_MS = 1000

export function wireUnifiedInbox(): void {
  const { schedule } = makeRebuildScheduler(
    () => { void useUnifiedInboxStore.getState().rebuild() },
    { debounceMs: REBUILD_DEBOUNCE_MS, maxWaitMs: REBUILD_MAX_WAIT_MS },
  )
  void useUnifiedInboxStore.getState().rebuild()
  useInboxStore.subscribe((s, prev) => { if (s.threads !== prev.threads) schedule() })
  useChatStore.subscribe((s, prev) => { if (s.rooms !== prev.rooms) schedule() })
  useFeedStore.subscribe((s, prev) => { if (s.unreadCounts !== prev.unreadCounts || s.feeds !== prev.feeds) schedule() })
  useAgentStore.subscribe((s, prev) => { if (s.sessions !== prev.sessions) schedule() })
  // Review hand-backs rank off SpaceSummary.reviewAgentKeys / reviewCards.
  // The spaces list itself is fetched at boot + on every (re)connect by
  // wireBoardSubscription — the Inbox may be the landing pane.
  useSpacesStore.subscribe((s, prev) => { if (s.spaces !== prev.spaces) schedule() })
  // Overdue-ness (SLA) is a function of wall clock, not store events — a DM
  // crosses its 24h line with no delta firing. Coarse re-sweep.
  setInterval(schedule, 5 * 60_000)
}
