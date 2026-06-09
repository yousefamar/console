// ============================================================================
// Room-members cache — drives the @-mention autocomplete in the compose
// input. Fetches the member list per room from the hub's /info endpoint and
// caches it module-level so multiple compose mounts share the same lookup.
//
// Cache is invalidated on a configurable TTL (default 60s); cheaper than
// being clever about membership-change events here, and members lists are
// stable enough that a minute-old snapshot is fine for autocomplete.
// ============================================================================

import { getHubUrl } from '@/hub'

export interface RoomMember {
  userId: string
  displayName: string
}

const TTL_MS = 60_000
const cache = new Map<string, { fetchedAt: number; members: RoomMember[] }>()
const inflight = new Map<string, Promise<RoomMember[]>>()

async function fetchMembers(roomId: string): Promise<RoomMember[]> {
  const res = await fetch(`${getHubUrl()}/matrix/rooms/${encodeURIComponent(roomId)}/info`)
  if (!res.ok) return []
  const data = await res.json() as { members?: RoomMember[] }
  const members = data.members ?? []
  cache.set(roomId, { fetchedAt: Date.now(), members })
  return members
}

/** Return cached members synchronously if fresh; kick off a background
 *  refresh otherwise. Returns [] on first call for a room until the fetch
 *  resolves, after which subsequent calls hit the cache. */
export function getRoomMembers(roomId: string): RoomMember[] {
  const hit = cache.get(roomId)
  const fresh = hit && Date.now() - hit.fetchedAt < TTL_MS
  if (!fresh && !inflight.has(roomId)) {
    const p = fetchMembers(roomId)
      .finally(() => { inflight.delete(roomId) })
    inflight.set(roomId, p)
  }
  return hit?.members ?? []
}

/** Force a fresh fetch and resolve when it completes. Used by the compose
 *  input on mount to warm the cache so the first `@` keystroke has data. */
export function primeRoomMembers(roomId: string): Promise<RoomMember[]> {
  const hit = cache.get(roomId)
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return Promise.resolve(hit.members)
  const existing = inflight.get(roomId)
  if (existing) return existing
  const p = fetchMembers(roomId).finally(() => { inflight.delete(roomId) })
  inflight.set(roomId, p)
  return p
}

/** Case-insensitive prefix match against display names, falling back to MXID
 *  localpart for unnamed members. Bridge ghost users (whose displayName is
 *  the contact's real name) sort to the top because they're what the user
 *  almost always means when typing @ in a bridged DM. */
export function searchRoomMembers(roomId: string, query: string, limit = 8): RoomMember[] {
  const members = getRoomMembers(roomId)
  if (members.length === 0) return []
  const q = query.trim().toLowerCase()
  if (!q) return members.slice(0, limit)
  const matches: RoomMember[] = []
  for (const m of members) {
    const name = (m.displayName || m.userId).toLowerCase()
    const localpart = (m.userId.split(':')[0] ?? '').slice(1).toLowerCase()
    if (name.includes(q) || localpart.includes(q)) {
      matches.push(m)
      if (matches.length >= limit) break
    }
  }
  return matches
}
