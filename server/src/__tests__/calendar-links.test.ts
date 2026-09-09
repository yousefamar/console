// Private per-event links: the pure module + the hub routes against a fake
// CalendarClient (no Google calls). The route contract that matters: adding
// and removing rewrite the WHOLE private-link set with vacated keys nulled,
// and `/cal/events/:id/links` is matched before the bare `/cal/events/:id`.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  readLinks, linksPatch, addLink, removeLink, LinkTooLongError,
  LINK_KEY_PREFIX, LINK_MARKER_KEY, LINK_MARKER_FILTER, LINK_VALUE_MAX,
} from '../calendar-links.js'
import { handleCalendarRoutes } from '../routes/calendar.js'
import type { CalendarClient } from '../calendar-client.js'
import type { AuthStore } from '../auth-store.js'

const ev = (priv: Record<string, string>) => ({ id: 'e1', extendedProperties: { private: priv } })

describe('calendar-links (pure)', () => {
  it('reads links in key order and ignores foreign private props', () => {
    const e = ev({ 'console.link.2': '/c', other: 'x', 'console.link.0': '/a', 'console.link.1': '/b', [LINK_MARKER_KEY]: '1' })
    expect(readLinks(e)).toEqual(['/a', '/b', '/c'])
    expect(readLinks({})).toEqual([])
    expect(readLinks(null)).toEqual([])
  })

  it('linksPatch renumbers densely and NULLS vacated keys + marker', () => {
    const e = ev({ 'console.link.0': '/a', 'console.link.1': '/b', 'console.link.2': '/c', [LINK_MARKER_KEY]: '1', keep: 'me' })
    const p = linksPatch(e, ['/a', '/c']).extendedProperties.private
    expect(p).toEqual({ 'console.link.0': '/a', 'console.link.1': '/c', 'console.link.2': null, [LINK_MARKER_KEY]: '1' })
    expect(p).not.toHaveProperty('keep')           // untouched props are not sent (PATCH merges)
    const empty = linksPatch(e, []).extendedProperties.private
    expect(empty[LINK_MARKER_KEY]).toBeNull()       // marker cleared when the last link goes
    expect(empty[`${LINK_KEY_PREFIX}0`]).toBeNull()
  })

  it('addLink dedupes, trims, and refuses values Google would truncate', () => {
    expect(addLink(['/a'], ' /a ')).toEqual(['/a'])
    expect(addLink(['/a'], '/b')).toEqual(['/a', '/b'])
    expect(() => addLink([], 'x'.repeat(LINK_VALUE_MAX + 1))).toThrow(LinkTooLongError)
    expect(() => addLink([], '  ')).toThrow()
    expect(removeLink(['/a', '/b'], '/a')).toEqual(['/b'])
  })

  it('the marker filter is exact key=value (what events.list accepts)', () => {
    expect(LINK_MARKER_FILTER).toBe('console.links=1')
  })
})

// --- routes -----------------------------------------------------------------

function fakeHttp(method: string, path: string, body?: unknown) {
  const res = { status: 0, body: '' }
  const request = { method, url: path } as IncomingMessage
  const response = {
    writeHead: (status: number) => { res.status = status },
    end: (chunk?: string) => { res.body = chunk ?? '' },
  } as unknown as ServerResponse
  const readBody = async () => JSON.stringify(body ?? {})
  return { request, response, readBody, res, url: new URL(`http://h${path}`) }
}
const settle = () => new Promise((r) => setTimeout(r, 5))

function fakeCalendar(initialPriv: Record<string, string>) {
  const patches: unknown[] = []
  const listCalls: unknown[] = []
  let priv = { ...initialPriv }
  const client = {
    getEvent: async () => ({ id: 'e1', summary: 'S', extendedProperties: { private: { ...priv } } }),
    patchEvent: async (_a: string, _c: string, _e: string, updates: any) => {
      patches.push(updates)
      // Emulate Google: null deletes, string sets, omitted keys stay.
      for (const [k, v] of Object.entries(updates.extendedProperties.private as Record<string, string | null>)) {
        if (v === null) delete priv[k]; else priv[k] = v
      }
      return { id: 'e1' }
    },
    getEvents: async (_a: string, _c: string, opts: unknown) => { listCalls.push(opts); return { items: [{ id: 'e1', summary: 'S', extendedProperties: { private: { ...priv } } }] } },
    getCalendarList: async () => ({ items: [{ id: 'primary', accessRole: 'owner' }, { id: 'ro', accessRole: 'reader' }] }),
  } as unknown as CalendarClient
  const auth = { getPrimaryGoogleAccount: () => ({ email: 'me@x' }), getGoogleAccounts: () => [{ email: 'me@x' }] } as unknown as AuthStore
  return { client, auth, patches, listCalls, priv: () => priv }
}

describe('calendar link routes', () => {
  it('POST adds (rewriting the set) and DELETE nulls the vacated key', async () => {
    const cal = fakeCalendar({ 'console.link.0': '/a', [LINK_MARKER_KEY]: '1' })
    let h = fakeHttp('POST', '/cal/events/e1/links', { calendarId: 'primary', path: '/b' })
    expect(handleCalendarRoutes(h.request, h.response, '/cal/events/e1/links', h.url, cal.client, cal.auth, h.readBody)).toBe(true)
    await settle()
    expect(h.res.status).toBe(200)
    expect(JSON.parse(h.res.body)).toEqual({ links: ['/a', '/b'], changed: true })
    expect(cal.priv()).toEqual({ 'console.link.0': '/a', 'console.link.1': '/b', [LINK_MARKER_KEY]: '1' })

    h = fakeHttp('DELETE', '/cal/events/e1/links?calendarId=primary&path=%2Fa')
    handleCalendarRoutes(h.request, h.response, '/cal/events/e1/links', h.url, cal.client, cal.auth, h.readBody)
    await settle()
    expect(JSON.parse(h.res.body)).toEqual({ links: ['/b'], changed: true })
    expect(cal.priv()).toEqual({ 'console.link.0': '/b', [LINK_MARKER_KEY]: '1' })
    expect((cal.patches[1] as any).extendedProperties.private['console.link.1']).toBeNull()
  })

  it('adding an existing link is a no-op (no PATCH); missing calendarId/path are 400; too long is 422', async () => {
    const cal = fakeCalendar({ 'console.link.0': '/a', [LINK_MARKER_KEY]: '1' })
    let h = fakeHttp('POST', '/cal/events/e1/links', { calendarId: 'primary', path: '/a' })
    handleCalendarRoutes(h.request, h.response, '/cal/events/e1/links', h.url, cal.client, cal.auth, h.readBody)
    await settle()
    expect(JSON.parse(h.res.body)).toEqual({ links: ['/a'], changed: false })
    expect(cal.patches).toHaveLength(0)

    h = fakeHttp('POST', '/cal/events/e1/links', { path: '/b' })
    handleCalendarRoutes(h.request, h.response, '/cal/events/e1/links', h.url, cal.client, cal.auth, h.readBody)
    await settle(); expect(h.res.status).toBe(400)

    h = fakeHttp('POST', '/cal/events/e1/links', { calendarId: 'primary', path: 'x'.repeat(2000) })
    handleCalendarRoutes(h.request, h.response, '/cal/events/e1/links', h.url, cal.client, cal.auth, h.readBody)
    await settle(); expect(h.res.status).toBe(422)
  })

  it('GET /links lists; GET /cal/events/:id carries derived `links`; /linked filters server-side and skips read-only calendars', async () => {
    const cal = fakeCalendar({ 'console.link.0': '/a', [LINK_MARKER_KEY]: '1' })
    let h = fakeHttp('GET', '/cal/events/e1/links?calendarId=primary')
    handleCalendarRoutes(h.request, h.response, '/cal/events/e1/links', h.url, cal.client, cal.auth, h.readBody)
    await settle(); expect(JSON.parse(h.res.body)).toEqual({ links: ['/a'] })

    h = fakeHttp('GET', '/cal/events/e1?calendarId=primary')
    handleCalendarRoutes(h.request, h.response, '/cal/events/e1', h.url, cal.client, cal.auth, h.readBody)
    await settle(); expect(JSON.parse(h.res.body)).toMatchObject({ id: 'e1', links: ['/a'] })

    h = fakeHttp('GET', '/cal/linked?timeMin=2026-01-01T00:00:00Z')
    handleCalendarRoutes(h.request, h.response, '/cal/linked', h.url, cal.client, cal.auth, h.readBody)
    await settle()
    expect(JSON.parse(h.res.body).items).toEqual([expect.objectContaining({ id: 'e1', calendarId: 'primary', links: ['/a'] })])
    expect(cal.listCalls).toHaveLength(1)   // the `reader` calendar was skipped
    expect(cal.listCalls[0]).toMatchObject({ privateExtendedProperty: LINK_MARKER_FILTER })
  })
})
