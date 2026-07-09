// Hub Meetup subscriber — mirrors the hub-authoritative Meetup events store into
// the client's Dexie cache + the map store. Gives offline rendering and live
// cross-device updates (a fetch-area on PC shows up on the phone's map).
//
// Wire shape matches server/src/index.ts's `meetup` SyncBus service:
//   snapshot RPC → { events: MeetupEvent[] }   (summaries only)
//   `delta` broadcast → { events: MeetupEvent[] } (the rows that just changed)

import { db, type DbMeetupEvent } from '@/db'
import { hubBus } from '@/sync-bus'
import { useMapStore, type MeetupEvent } from '@/store/map'

interface MeetupEnvelope {
  events: MeetupEvent[]
}

function toDb(ev: MeetupEvent): DbMeetupEvent {
  const { detail: _detail, ...summary } = ev
  return summary
}

function apply(events: MeetupEvent[] | undefined): void {
  if (!events?.length) return
  void db.meetupEvents.bulkPut(events.map(toDb)).catch(() => {})
  useMapStore.getState().mergeEvents(events)
}

async function hydrateFromDb(): Promise<void> {
  try {
    const rows = await db.meetupEvents.toArray()
    if (rows.length) useMapStore.getState().mergeEvents(rows as MeetupEvent[])
  } catch {
    // empty / unavailable — fine
  }
}

async function fetchSnapshot(): Promise<void> {
  const env = await hubBus.rpc<MeetupEnvelope>('meetup', 'snapshot', undefined)
  if (!env?.events) return
  // The snapshot is AUTHORITATIVE: the hub prunes expired events and its store
  // can shrink (e.g. a manual cleanup). Merge-only mirroring kept deleted
  // events alive client-side forever, so replace — drop Dexie rows and store
  // entries absent from the snapshot, preserving loaded `detail` on survivors.
  const keep = new Set(env.events.map((e) => e.id))
  try {
    const stale = (await db.meetupEvents.toArray()).filter((r) => !keep.has(r.id)).map((r) => r.id)
    if (stale.length) await db.meetupEvents.bulkDelete(stale)
  } catch {
    // Dexie unavailable — in-memory replace below still corrects the UI
  }
  void db.meetupEvents.bulkPut(env.events.map(toDb)).catch(() => {})
  const prev = new Map(useMapStore.getState().events.map((e) => [e.id, e]))
  useMapStore.setState({
    events: env.events.map((ev) => {
      const old = prev.get(ev.id)
      return old?.detail && !ev.detail ? { ...ev, detail: old.detail } : ev
    }),
  })
}

/** Idempotent; call once on boot. Returns an unsubscribe function. */
export function wireMeetupSubscription(): () => void {
  void hydrateFromDb()
  const unsubDelta = hubBus.on('meetup', 'delta', (data) => apply((data as MeetupEnvelope).events))
  const unsubConnect = hubBus.onConnect(() => { void fetchSnapshot().catch(() => {}) })
  return () => {
    unsubDelta()
    unsubConnect()
  }
}
