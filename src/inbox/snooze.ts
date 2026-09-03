// One snooze system for every Inbox source.
//
// Each source already owns the durable half in the place that survives best:
// mail on the thread row (hub-synced via the offline queue, which archives on
// Gmail), chat on the room snapshot (hub RPC, so every device agrees), and
// feed items / agent sessions in the local `itemSnooze` table — those two have
// no server-side snooze concept and none is worth inventing. This module is
// the single dispatcher over the four, so the picker, the `b` key and any
// future affordance all snooze the same way.

import { db } from '@/db'
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useUiStore } from '@/store/ui'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { getSnoozeTime } from '@/utils/date'
import type { InboxSource, SnoozeTarget } from './types'

export type SnoozeOption = 'laterToday' | 'tomorrow' | 'nextWeek' | 'custom'

type Snoozable = Pick<SnoozeTarget, 'source' | 'sourceId' | 'key'>

const UNDO_MS = 5000

/** Sources whose rows can be snoozed — all of them, hence no per-source
 *  branching at the call sites. Kept as a function so a future source that
 *  genuinely cannot snooze has one place to say so. */
export function canSnooze(source: InboxSource | null | undefined): source is InboxSource {
  return !!source
}

/** Snooze in the owning store. `advance` is the legacy pane's "step my
 *  selection to the neighbour" behaviour — the unified Inbox passes false
 *  because it advances its own composed list. */
export async function snoozeItem(item: Snoozable, option: SnoozeOption, customDate?: Date, opts: { advance?: boolean } = {}): Promise<void> {
  switch (item.source) {
    case 'mail':
      useInboxStore.getState().snoozeThread(option, customDate, item.sourceId, opts)
      return
    case 'chat':
      await useChatStore.getState().snoozeRoom(option, customDate, item.sourceId, opts)
      return
    default: {
      const snoozedUntil = getSnoozeTime(option, customDate)
      // Opportunistic prune — expired rows are inert but needn't accumulate.
      await db.itemSnooze.where('snoozedUntil').below(Date.now()).delete()
      await db.itemSnooze.put({ key: item.key, snoozedUntil })
    }
  }
}

/** Reverse a snooze — the undo-toast path, and the only way a mail thread
 *  comes back before its time (the wake sweep handles the due case). */
export async function unsnoozeItem(item: Snoozable): Promise<void> {
  switch (item.source) {
    case 'mail':
      await useInboxStore.getState().unsnoozeThread(item.sourceId)
      return
    case 'chat':
      await useChatStore.getState().unsnoozeRoom(item.sourceId)
      return
    default:
      await db.itemSnooze.delete(item.key)
  }
}

/** Locally-snoozed items still in their snooze window: key → due (ms). */
export async function activeLocalSnoozes(now: number): Promise<Map<string, number>> {
  return new Map((await db.itemSnooze.where('snoozedUntil').above(now).toArray()).map((r) => [r.key, r.snoozedUntil]))
}

/** "tomorrow 8:00 AM" / "Mon 8:00 AM" — for the undo toast, so a mis-hit
 *  reads as what it did, not just that it did something. */
export function snoozeLabel(until: number, now = Date.now()): string {
  const d = new Date(until)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  const tomorrow = new Date(now + 86_400_000)
  if (sameDay(d, today)) return time
  if (sameDay(d, tomorrow)) return `tomorrow ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** The picker's commit: snooze the target, close the picker, offer undo.
 *  An Inbox-origin target is dropped from the composed lists and the
 *  selection advanced FIRST — synchronously, so the row vanishes on the
 *  keypress rather than whenever the debounced rebuild next lands. The undo
 *  toast is armed synchronously too: the source-store snooze awaits a hub
 *  round-trip (chat RPC, mail queue), and a toast that lands a second late
 *  overwrites whatever the user snoozed NEXT — undo would then reverse the
 *  wrong item. */
export function applySnooze(target: SnoozeTarget, option: SnoozeOption, customDate?: Date): void {
  const ui = useUiStore.getState()
  ui.closeSnoozePicker()
  const fromInbox = target.origin === 'inbox'
  const until = getSnoozeTime(option, customDate)
  if (fromInbox) useUnifiedInboxStore.getState().dropAndAdvance(target.key, { snoozedUntil: until })
  // Rebuild once the snooze has landed so the snoozed view agrees — a
  // feed/agent snooze writes only Dexie, which no store subscription sees.
  void snoozeItem(target, option, customDate, { advance: !fromInbox })
    .catch(() => {})
    .then(() => useUnifiedInboxStore.getState().rebuild())
  ui.setUndoAction({
    label: `Snoozed until ${snoozeLabel(until)}`,
    expiresAt: Date.now() + UNDO_MS,
    undo: async () => {
      useUiStore.getState().setUndoAction(null)
      await unsnoozeItem(target)
      useUnifiedInboxStore.getState().restore(target.key)
      await useUnifiedInboxStore.getState().rebuild()
      if (fromInbox) {
        // Re-read AFTER the rebuild — a getState() snapshot taken before it
        // holds the pre-rebuild lists.
        const { inboxList, feedList, select } = useUnifiedInboxStore.getState()
        const back = [...inboxList, ...feedList].find((i) => i.key === target.key)
        if (back) select(back)
      }
    },
  })
}
