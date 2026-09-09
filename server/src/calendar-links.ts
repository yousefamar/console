// Private per-event links — a local file path (or any string) attached to a
// Google Calendar event so that only YOUR copy of the event carries it.
//
// Google has no user-facing private-notes field: description, attachments
// and the Meet notes doc are all shared with every guest. The one private
// channel is `extendedProperties.private` — key/value pairs stored on the
// attendee's own copy of the event, never propagated to other guests and
// never rendered by Google's UI. Limits (API guide): key ≤44 chars, value
// ≤1024 chars (silently truncated), 300 properties / 32 KB per event.
//
// Layout: one link per key `console.link.<i>` (0-based, dense) plus a constant
// marker `console.links=1` so `events.list?privateExtendedProperty=console.links=1`
// finds linked events server-side (the filter is exact key=value, so the marker
// must not carry a count). Removing a link rewrites the whole set
// and nulls the vacated keys — a PATCH that omits a key leaves it in place.

export const LINK_KEY_PREFIX = 'console.link.'
export const LINK_MARKER_KEY = 'console.links'
export const LINK_MARKER_VALUE = '1'
/** The `privateExtendedProperty` query value that selects linked events. */
export const LINK_MARKER_FILTER = `${LINK_MARKER_KEY}=${LINK_MARKER_VALUE}`
export const LINK_VALUE_MAX = 1024

type PrivateProps = Record<string, string | null>

interface EventLike {
  extendedProperties?: { private?: Record<string, string> | null; shared?: Record<string, string> | null } | null
}

/** Links stored on this copy of the event, in key order. */
export function readLinks(event: EventLike | null | undefined): string[] {
  const priv = event?.extendedProperties?.private ?? {}
  return Object.entries(priv)
    .filter(([k, v]) => k.startsWith(LINK_KEY_PREFIX) && typeof v === 'string' && v.length > 0)
    .map(([k, v]) => [Number(k.slice(LINK_KEY_PREFIX.length)), v] as const)
    .filter(([i]) => Number.isInteger(i) && i >= 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
}

/** The `extendedProperties.private` patch that makes the event carry exactly
 *  `links` — vacated keys are nulled so the old entries actually go away. */
export function linksPatch(event: EventLike | null | undefined, links: string[]): { extendedProperties: { private: PrivateProps } } {
  const current = event?.extendedProperties?.private ?? {}
  const priv: PrivateProps = {}
  for (const k of Object.keys(current)) {
    if (k.startsWith(LINK_KEY_PREFIX) || k === LINK_MARKER_KEY) priv[k] = null
  }
  links.forEach((l, i) => { priv[`${LINK_KEY_PREFIX}${i}`] = l })
  priv[LINK_MARKER_KEY] = links.length ? LINK_MARKER_VALUE : null
  return { extendedProperties: { private: priv } }
}

export class LinkTooLongError extends Error {
  constructor(len: number) { super(`link is ${len} chars; Google truncates private property values past ${LINK_VALUE_MAX}`) }
}

/** Add `link` (deduped, order kept). Throws when the value would be truncated. */
export function addLink(links: string[], link: string): string[] {
  const l = link.trim()
  if (!l) throw new Error('empty link')
  if (l.length > LINK_VALUE_MAX) throw new LinkTooLongError(l.length)
  return links.includes(l) ? links : [...links, l]
}

export function removeLink(links: string[], link: string): string[] {
  const l = link.trim()
  return links.filter((x) => x !== l)
}
