import { hubFetch } from '../client.js'
import { output, exitWithError, info, type GlobalFlags } from '../output.js'
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
    default:
      exitWithError('USAGE', `Unknown cal command: ${verb}. Run 'con help cal'.`, flags)
  }
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

  // Relative: +Nd, +Nw
  const relMatch = input.match(/^\+(\d+)([dwm])$/)
  if (relMatch) {
    const base = relativeTo || new Date()
    const n = parseInt(relMatch[1]!, 10)
    const unit = relMatch[2]!
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
