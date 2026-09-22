/**
 * Client port of the hub's `isVisibleCalendar` (server/src/cal/visibility.ts)
 * and Android's `isSelectedCalendar` (CalVisibility.kt) — keep the three in sync.
 *
 * Google Calendar shows a list entry only when `selected` is literally true.
 * The API OMITS the field when it is false ("Optional. The default is False."),
 * so `selected !== false` let every unchecked calendar through.
 */
export function isShownInGoogle(c: { selected?: boolean; hidden?: boolean; deleted?: boolean }): boolean {
  return c.selected === true && c.hidden !== true && c.deleted !== true
}
