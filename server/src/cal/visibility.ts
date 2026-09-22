// Which calendars and events are Yousef's — the one rule behind every
// fan-out over "all calendars" (GET /cal/events, late-check, cal sync).
//
// Every linked Google account is his (only he can link one), but each
// account's calendarList also carries calendars other people shared with him:
// as a Workspace admin he holds `accessRole: owner` on colleagues' primary
// calendars (sam@artanis.ai, olly@artanis.ai), and they sit UNTICKED in Google
// Calendar. Google draws exactly the ticked calendars, so we do too.

export interface CalendarListEntry {
  id: string
  accountEmail: string
  primary?: boolean
  selected?: boolean
  hidden?: boolean
  deleted?: boolean
  accessRole?: string
}

export interface AttendeeLike { email?: string; self?: boolean; responseStatus?: string }
export interface EventLike { attendees?: AttendeeLike[] | null }

export const ownEmails = (accounts: Array<{ email: string }>): Set<string> =>
  new Set(accounts.map((a) => a.email.toLowerCase()))

/** Ticked in Google Calendar's sidebar. Google OMITS `selected` when it is
 *  false, so `!== false` lets every unticked calendar through — the original leak. */
export const isVisibleCalendar = (cal: Pick<CalendarListEntry, 'selected' | 'hidden' | 'deleted'>): boolean =>
  cal.selected === true && !cal.hidden && !cal.deleted

/** Google-managed ids (secondary, subscribed, holiday, room) — never a person's address. */
const GOOGLE_MANAGED_ID = /@(group|import|resource)\.calendar\.google\.com$|@group\.v\.calendar\.google\.com$/i

/** A calendar of his: a primary of one of his accounts (shared into another of
 *  his accounts too), or a secondary calendar he owns. A colleague's primary he
 *  can edit is NOT his — `accessRole: owner` on someone else's address. */
export const isOwnCalendar = (cal: CalendarListEntry, own: Set<string>): boolean =>
  !!cal.primary || own.has(cal.id.toLowerCase()) || (cal.accessRole === 'owner' && GOOGLE_MANAGED_ID.test(cal.id))

const ROLE_RANK: Record<string, number> = { owner: 3, writer: 2, reader: 1, freeBusyReader: 0 }
const rank = (cal: CalendarListEntry): number => (cal.primary ? 10 : 0) + (ROLE_RANK[cal.accessRole ?? ''] ?? 0)

/** What Google Calendar shows him: the ticked calendars of all his accounts,
 *  each once. yousef@artanis.ai is a primary in one account and a shared
 *  calendar in another — keep the copy with the most access. */
export function visibleCalendars<T extends CalendarListEntry>(entries: T[]): T[] {
  const byId = new Map<string, T>()
  for (const cal of entries) {
    if (!isVisibleCalendar(cal)) continue
    const prev = byId.get(cal.id)
    if (!prev || rank(cal) > rank(prev)) byId.set(cal.id, cal)
  }
  return [...byId.values()]
}

/** He is going: invited under one of his addresses and not declined, or on a
 *  calendar of his with no decline. Another person's calendar only contributes
 *  events he is invited to — never their private meetings. `attendees[].self`
 *  marks the CALENDAR owner, so it is only trusted on his own calendars. */
export function attendsEvent(ev: EventLike, cal: CalendarListEntry, own: Set<string>): boolean {
  const attendees = ev.attendees ?? []
  const me = attendees.find((a) => a.email && own.has(a.email.toLowerCase()))
  if (me) return me.responseStatus !== 'declined'
  if (!isOwnCalendar(cal, own)) return false
  return attendees.find((a) => a.self)?.responseStatus !== 'declined'
}
