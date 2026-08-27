// Boot wiring for the unified Inbox pane — lives here (called from
// GatedBoot), NOT in InboxTab's mount effect: the tab-bar unread badge needs
// the composed lists live from boot, and InboxTab only mounts while active
// (the ^deft-ant lesson — never let a lazily-mounted component own de-facto
// boot wiring).

import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useFeedStore } from '@/store/feeds'
import { useUnifiedInboxStore } from '@/store/unified-inbox'

const REBUILD_DEBOUNCE_MS = 300

export function wireUnifiedInbox(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void useUnifiedInboxStore.getState().rebuild() }, REBUILD_DEBOUNCE_MS)
  }
  void useUnifiedInboxStore.getState().rebuild()
  useInboxStore.subscribe((s, prev) => { if (s.threads !== prev.threads) schedule() })
  useChatStore.subscribe((s, prev) => { if (s.rooms !== prev.rooms) schedule() })
  useFeedStore.subscribe((s, prev) => { if (s.unreadCounts !== prev.unreadCounts || s.feeds !== prev.feeds) schedule() })
}
