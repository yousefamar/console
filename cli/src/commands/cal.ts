import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { hubFetch } from '../client.js'
import { output, exitWithError, info, isJsonMode, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function cal(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'calendars': return calCalendars(args, flags)
    case 'events': return calEvents(args, flags)
    case 'get': return calGet(args, flags)
    case 'create': return calCreate(args, flags)
    case 'edit': return calEdit(args, flags)
    case 'delete': return calDelete(args, flags)
    case 'rsvp': return calRsvp(args, flags)
    case 'location': return calLocation(args, flags)
    case 'accounts': return calAccounts(flags)
    case 'add-account': return calAddAccount(flags)
    case 'remove-account': return calRemoveAccount(args, flags)
    case 'flights': return calFlights(args, flags)
    case 'eventbrite': return calEventbrite(args, flags)
    case 'link': return calLink(args, flags)
    case 'unlink': return calUnlink(args, flags)
    case 'links': return calLinks(args, flags)
    case 'linked': return calLinked(args, flags)
    default:
      exitWithError('USAGE', `Unknown cal command: ${verb}. Run 'con help cal'.`, flags)
  }
}

// --------------------------------------------------------------------------
// Flights subcommand — SerpApi-backed flight search & watchlists
// --------------------------------------------------------------------------

async function calFlights(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case 'explore': return flightExplore(rest, flags)
    case 'search': return flightSearch(rest, flags)
    case 'watch': return flightWatch(rest, flags)
    case 'status': return flightStatus(flags)
    case 'credentials': return flightCredentials(rest, flags)
    default:
      // Arc rendering lives under `con map flights` (the Map tab is its home).
      exitWithError('USAGE', "Usage: con cal flights {explore|search|watch|status|credentials}. For map arcs: con map flights push", flags)
  }
}

async function flightStatus(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/flights/status')
  output(data, flags)
}

async function flightCredentials(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.key) exitWithError('USAGE', 'Usage: con cal flights credentials --key <serpapi-key>', flags)
  const result = await hubFetch('/flights/credentials', { method: 'POST', body: { apiKey: opts.key } })
  output(result, flags)
}

async function flightExplore(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.from) exitWithError('USAGE', 'Usage: con cal flights explore --from LHR [--region europe] [--to <code>] [--month 11] [--duration "1 week"]', flags)
  const params: Record<string, string | undefined> = {
    from: opts.from,
    to: opts.to,
    region: opts.region,
    month: opts.month,
    duration: opts.duration,
    currency: opts.currency,
  }
  const data = await hubFetch('/flights/explore', { params })
  output(data, flags)
}

async function flightSearch(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.from || !opts.to || !opts.date) {
    exitWithError('USAGE', 'Usage: con cal flights search --from LHR --to JFK --date 2026-08-15 [--return 2026-08-22] [--class 1] [--adults 1]', flags)
  }
  const params: Record<string, string | undefined> = {
    from: opts.from,
    to: opts.to,
    date: opts.date,
    return: opts.return,
    class: opts.class,
    adults: opts.adults,
    currency: opts.currency,
  }
  const data = await hubFetch('/flights/search', { params })
  output(data, flags)
}

async function flightWatch(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case 'list': return flightWatchList(flags)
    case 'add': return flightWatchAdd(rest, flags)
    case 'remove': return flightWatchRemove(rest, flags)
    case 'run': return flightWatchRun(rest, flags)
    default:
      exitWithError('USAGE', 'Usage: con cal flights watch {list|add|remove|run}', flags)
  }
}

async function flightWatchList(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/flights/watchlists')
  output(data, flags)
}

async function flightWatchAdd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const kind = opts.kind || (opts.date ? 'route' : 'explore')
  if (!opts.from) exitWithError('USAGE', 'Provide --from <origin-code>', flags)

  const body: Record<string, unknown> = {
    kind,
    origin: opts.from,
    label: opts.label,
    currency: opts.currency || 'GBP',
    maxPriceMajor: opts.max ? parseFloat(opts.max) : undefined,
  }
  if (kind === 'explore') {
    body.region = opts.region
    body.destination = opts.to
    body.month = opts.month ? parseInt(opts.month, 10) : 0
    body.duration = opts.duration || '1 week'
  } else {
    if (!opts.to || !opts.date) exitWithError('USAGE', 'Route watchlist needs --to and --date', flags)
    body.destination = opts.to
    body.outboundDate = opts.date
    body.returnDate = opts.return
    body.travelClass = opts.class ? parseInt(opts.class, 10) : undefined
    body.adults = opts.adults ? parseInt(opts.adults, 10) : 1
  }

  if (flags.dryRun) { info(`Would create ${kind} watchlist from ${opts.from}`); return }
  const result = await hubFetch('/flights/watchlists', { method: 'POST', body })
  output(result, flags)
}

async function flightWatchRemove(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) exitWithError('USAGE', 'Usage: con cal flights watch remove <id>', flags)
  if (flags.dryRun) { info(`Would remove watchlist ${id}`); return }
  await hubFetch(`/flights/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' })
  output({ removed: id }, flags)
}

async function flightWatchRun(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) exitWithError('USAGE', 'Usage: con cal flights watch run <id>', flags)
  const result = await hubFetch(`/flights/watchlists/${encodeURIComponent(id)}/run`, { method: 'POST' })
  output(result, flags)
}

async function calCalendars(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch('/cal/calendars', { params: { account: opts.account } })
  output(data, flags)
}

async function calEvents(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)

  // Parse relative dates
  const from = parseDate(opts.from || 'today')
  const to = parseDate(opts.to || '+7d', from)

  const data = await hubFetch('/cal/events', {
    params: {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      calendarId: opts.calendar,
      account: opts.account,
      singleEvents: 'true',
    },
  })
  output(data, flags)
}

async function calGet(args: string[], flags: GlobalFlags): Promise<void> {
  const eventId = args[0]
  if (!eventId) exitWithError('USAGE', 'Usage: con cal get <event-id> --calendar <id>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.calendar) exitWithError('USAGE', 'Provide --calendar', flags)
  const data = await hubFetch(`/cal/events/${encodeURIComponent(eventId)}`, {
    params: { calendarId: opts.calendar, account: opts.account },
  })
  output(data, flags)
}

async function calCreate(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.calendar || !opts.title || !opts.start || !opts.end) {
    exitWithError('USAGE', 'Usage: con cal create --calendar <id> --title <t> --start <dt> --end <dt>', flags)
  }

  if (flags.dryRun) { info(`Would create event: ${opts.title}`); return }

  const body: Record<string, unknown> = {
    calendarId: opts.calendar,
    account: opts.account,
    summary: opts.title,
    description: opts.description,
    location: opts.location,
  }

  if (opts['all-day'] === 'true') {
    body.start = { date: opts.start }
    body.end = { date: opts.end }
  } else {
    body.start = { dateTime: new Date(opts.start).toISOString() }
    body.end = { dateTime: new Date(opts.end).toISOString() }
  }

  const result = await hubFetch('/cal/events', { method: 'POST', body })
  output(result, flags)
}

async function calEdit(args: string[], flags: GlobalFlags): Promise<void> {
  const eventId = args[0]
  if (!eventId) exitWithError('USAGE', 'Usage: con cal edit <event-id> --calendar <id> [field flags...]', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.calendar) exitWithError('USAGE', 'Provide --calendar', flags)

  if (flags.dryRun) { info(`Would edit event: ${eventId}`); return }

  const body: Record<string, unknown> = {
    calendarId: opts.calendar,
    account: opts.account,
  }

  if (opts.title) body.summary = opts.title
  if (opts.description) body.description = opts.description
  if (opts.location) body.location = opts.location
  if (opts.start) body.start = { dateTime: new Date(opts.start).toISOString() }
  if (opts.end) body.end = { dateTime: new Date(opts.end).toISOString() }

  const result = await hubFetch(`/cal/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body })
  output(result, flags)
}

async function calDelete(args: string[], flags: GlobalFlags): Promise<void> {
  const eventId = args[0]
  if (!eventId) exitWithError('USAGE', 'Usage: con cal delete <event-id> --calendar <id>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.calendar) exitWithError('USAGE', 'Provide --calendar', flags)

  if (flags.dryRun) { info(`Would delete event: ${eventId}`); return }

  await hubFetch(`/cal/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    params: { calendarId: opts.calendar, account: opts.account },
  })
  output({ deleted: eventId }, flags)
}

async function calRsvp(args: string[], flags: GlobalFlags): Promise<void> {
  const eventId = args[0]
  if (!eventId) exitWithError('USAGE', 'Usage: con cal rsvp <event-id> --calendar <id> --status <accept|maybe|decline>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.calendar || !opts.status) exitWithError('USAGE', 'Provide --calendar and --status', flags)

  if (flags.dryRun) { info(`Would RSVP ${opts.status} to ${eventId}`); return }

  const result = await hubFetch(`/cal/events/${encodeURIComponent(eventId)}/rsvp`, {
    method: 'POST',
    body: { calendarId: opts.calendar, account: opts.account, status: opts.status },
  })
  output(result, flags)
}

async function calLocation(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.date || !opts.type) {
    exitWithError('USAGE', 'Usage: con cal location --date <date> --type <home|office|custom> [--label <l>]', flags)
  }

  if (flags.dryRun) { info(`Would set location for ${opts.date}: ${opts.type}`); return }

  const result = await hubFetch('/cal/location', {
    method: 'POST',
    body: { date: opts.date, type: opts.type, label: opts.label, account: opts.account },
  })
  output(result, flags)
}

async function calAccounts(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/cal/accounts')
  output(data, flags)
}

async function calAddAccount(flags: GlobalFlags): Promise<void> {
  // Same flow as auth login google but for calendar-only scope
  info('Opening browser for Google Calendar sign-in...')
  const hubUrl = process.env.CONSOLE_HUB_URL || 'http://localhost:9877'
  const authUrl = `${hubUrl}/auth/google/start`
  try {
    const { exec } = await import('node:child_process')
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    exec(`${cmd} "${authUrl}"`)
  } catch {
    info(`Please open: ${authUrl}`)
  }

  // Poll
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const poll = await hubFetch<{ done: boolean; email?: string }>('/auth/google/poll')
    if (poll.done) {
      output({ added: poll.email }, flags)
      return
    }
  }
  exitWithError('TIMEOUT', 'Timed out waiting for authentication.', flags)
}

async function calRemoveAccount(args: string[], flags: GlobalFlags): Promise<void> {
  const email = args[0]
  if (!email) exitWithError('USAGE', 'Usage: con cal remove-account <email>', flags)
  await hubFetch(`/cal/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
  output({ removed: email }, flags)
}

// --------------------------------------------------------------------------
// Date parsing helpers
// --------------------------------------------------------------------------

function parseDate(input: string, relativeTo?: Date): Date {
  if (!input) return new Date()

  // Relative: +Nd, +Nw, -Nd …
  const relMatch = input.match(/^([+-])(\d+)([dwm])$/)
  if (relMatch) {
    const base = relativeTo || new Date()
    const n = parseInt(relMatch[2]!, 10) * (relMatch[1] === '-' ? -1 : 1)
    const unit = relMatch[3]!
    const result = new Date(base)
    if (unit === 'd') result.setDate(result.getDate() + n)
    else if (unit === 'w') result.setDate(result.getDate() + n * 7)
    else if (unit === 'm') result.setMonth(result.getMonth() + n)
    return result
  }

  // Named
  if (input === 'today') return new Date()
  if (input === 'tomorrow') {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d
  }

  // ISO date
  return new Date(input)
}

// --------------------------------------------------------------------------
// Eventbrite subcommand — follow organisers; their live events become the
// read-only "Eventbrite" calendar overlay
// --------------------------------------------------------------------------

async function calEventbrite(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case 'status': {
      output(await hubFetch('/eventbrite/status'), flags)
      return
    }
    case 'events': {
      const force = rest.includes('--force')
      output(await hubFetch(`/eventbrite/events${force ? '?force=1' : ''}`), flags)
      return
    }
    case 'follow': {
      const ref = rest.find((a) => !a.startsWith('--'))
      if (!ref) exitWithError('USAGE', 'Usage: con cal eventbrite follow <organiser URL | event URL | organiser id>', flags)
      output(await hubFetch('/eventbrite/organizers', { method: 'POST', body: { ref } }), flags)
      return
    }
    case 'unfollow': {
      const id = rest[0]
      if (!id) exitWithError('USAGE', 'Usage: con cal eventbrite unfollow <organiser id>', flags)
      output(await hubFetch(`/eventbrite/organizers/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
      return
    }
    case 'token': {
      const token = rest[0]
      if (!token) exitWithError('USAGE', 'Usage: con cal eventbrite token <personal OAuth token>', flags)
      output(await hubFetch('/eventbrite/token', { method: 'POST', body: { token } }), flags)
      return
    }
    default:
      exitWithError('USAGE', 'Usage: con cal eventbrite {status|events [--force]|follow <url|id>|unfollow <id>|token <token>}', flags)
  }
}

// --------------------------------------------------------------------------
// Private links — a local file path (or any string) attached to YOUR copy of
// an event via extendedProperties.private; no guest ever sees it, no Google
// UI renders it. `con cal get` also returns `links`.
// --------------------------------------------------------------------------

/** An existing file relative to the cwd becomes an absolute path (an
 *  unambiguous pointer); anything else — URLs, vault-relative paths, plain
 *  text — is stored verbatim. */
function normaliseLink(raw: string): string {
  const t = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  const abs = resolve(t)
  return existsSync(abs) ? abs : t
}

async function calLink(args: string[], flags: GlobalFlags): Promise<void> {
  const [eventId, target] = args
  if (!eventId || !target) exitWithError('USAGE', 'Usage: con cal link <event-id> <path|url> --calendar <id>', flags)
  const opts = parseFlags(args.slice(2))
  if (!opts.calendar) exitWithError('USAGE', 'Provide --calendar', flags)
  const link = normaliseLink(target!)
  if (flags.dryRun) { info(`Would link ${link} to event ${eventId}`); return }
  const result = await hubFetch(`/cal/events/${encodeURIComponent(eventId!)}/links`, {
    method: 'POST', body: { calendarId: opts.calendar, account: opts.account, path: link },
  })
  output(result, flags)
}

async function calUnlink(args: string[], flags: GlobalFlags): Promise<void> {
  const [eventId, target] = args
  if (!eventId || !target) exitWithError('USAGE', 'Usage: con cal unlink <event-id> <path|url> --calendar <id>', flags)
  const opts = parseFlags(args.slice(2))
  if (!opts.calendar) exitWithError('USAGE', 'Provide --calendar', flags)
  const link = normaliseLink(target!)
  if (flags.dryRun) { info(`Would unlink ${link} from event ${eventId}`); return }
  const result = await hubFetch(`/cal/events/${encodeURIComponent(eventId!)}/links`, {
    method: 'DELETE', params: { calendarId: opts.calendar, account: opts.account, path: link },
  })
  output(result, flags)
}

async function calLinks(args: string[], flags: GlobalFlags): Promise<void> {
  const eventId = args[0]
  if (!eventId) exitWithError('USAGE', 'Usage: con cal links <event-id> --calendar <id> [--cat]', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.calendar) exitWithError('USAGE', 'Provide --calendar', flags)
  const result = await hubFetch<{ links: string[] }>(`/cal/events/${encodeURIComponent(eventId)}/links`, {
    params: { calendarId: opts.calendar, account: opts.account },
  })
  if (!('cat' in opts)) { output(result, flags); return }
  // --cat: print the contents of every link that is a local text file (the CLI
  // runs on the same machine as the files), URLs/binaries are named only.
  const contents = result.links.map((link) => {
    const p = link.startsWith('~/') ? resolve(process.env.HOME ?? '', link.slice(2)) : link
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || !existsSync(p)) return { link, content: null, reason: existsSync(p) ? undefined : 'not a local file' }
    try {
      const st = statSync(p)
      if (st.size > 256 * 1024) return { link, content: null, reason: `${st.size} bytes — too large to print` }
      const buf = readFileSync(p)
      if (buf.subarray(0, 512).includes(0)) return { link, content: null, reason: 'binary' }
      return { link, content: buf.toString('utf8') }
    } catch (e) { return { link, content: null, reason: (e as Error).message } }
  })
  if (isJsonMode(flags)) { output({ links: contents }, flags); return }
  for (const c of contents) {
    console.log(`\n=== ${c.link}${c.reason ? `  (${c.reason})` : ''}`)
    if (c.content !== null) console.log(c.content)
  }
}

async function calLinked(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const from = parseDate(opts.from || '-30d')
  const to = parseDate(opts.to || '+90d', from)
  const result = await hubFetch('/cal/linked', {
    params: { timeMin: from.toISOString(), timeMax: to.toISOString(), calendarId: opts.calendar, account: opts.account },
  })
  output(result, flags)
}
