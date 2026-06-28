// con pen — control the Neo smartpen through the hub.
//
// All commands go: CLI → hub (/pen/*) → APK PushService → BLE → Neo pen.
// If the APK isn't connected on /push, the hub answers 503 and we surface a
// clear error. Mirrors `con glasses` (the pen is owned by the phone's APK).

import { hubFetch } from '../client.js'
import { output, info, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function pen(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return penStatus(flags)
    case 'devices': return penDevices(flags)
    case 'connect': return penConnect(args, flags)
    case 'disconnect': return penDisconnect(flags)
    case 'scan': return penScan(args, flags)
    case 'unlock': return penUnlock(args, flags)
    case 'forget': return penForget(flags)
    case 'stream': return penStream(args, flags)
    case 'research': return penResearch(args, flags)
    case 'offline': return penOffline(args, flags)
    default:
      exitWithError('USAGE', `Unknown pen command: ${verb}. Run 'con help pen'.`, flags)
  }
}

async function penStatus(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/pen/status')
  output(data, flags)
}

async function penDevices(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/pen/devices')
  output(data, flags)
}

async function penConnect(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  // Positional fallback: `con pen connect AA:BB:CC:DD:EE:FF`
  const positional = args.find((a) => !a.startsWith('--'))
  const mac = opts.mac ?? positional
  const body = mac ? { mac } : {}
  const data = await hubFetch('/pen/connect', { method: 'POST', body })
  output(data, flags)
}

async function penDisconnect(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/pen/disconnect', { method: 'POST' })
  output(data, flags)
}

// con pen scan [--ms N]        — trigger a BLE scan on the phone
// con pen scan observations    — dump every named advert seen recently
//
// Useful for debugging "scan finds no pen": the observations endpoint shows
// what names are actually advertising, regardless of whether they match the
// pen heuristic.
async function penScan(args: string[], flags: GlobalFlags): Promise<void> {
  const verb = args.find((a) => !a.startsWith('--')) ?? 'start'
  if (verb === 'start') {
    const opts = parseFlags(args)
    const durationMs = Number(opts.ms ?? '15000') || 15000
    const data = await hubFetch('/pen/scan', { method: 'POST', body: { durationMs } })
    output(data, flags)
    return
  }
  if (verb === 'observations' || verb === 'obs') {
    const data = await hubFetch('/pen/scan/observations')
    output(data, flags)
    return
  }
  exitWithError('USAGE', 'Usage: con pen scan [--ms N] | observations', flags)
}

async function penUnlock(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const positional = args.find((a) => !a.startsWith('--'))
  const password = opts.password ?? positional
  if (!password) exitWithError('USAGE', 'Usage: con pen unlock <password> | --password <pw>', flags)
  const data = await hubFetch('/pen/unlock', { method: 'POST', body: { password } })
  // The hub remembers a PIN once it actually authorizes the pen, then
  // auto-unlocks on future connects (forget it with `con pen forget`).
  output(data, flags)
}

// con pen forget — drop the remembered auto-unlock PIN (next connect needs a
// manual `con pen unlock <pin>` again).
async function penForget(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/pen/forget', { method: 'POST' })
  output(data, flags)
}

// con pen stream on|off|status — opt in/out of live-streaming pen pages into the
// Notes tab. Off by default; persisted; once on the hub re-registers on every
// connect. Coexists with the pen's offline-save (no backup is traded away).
async function penStream(args: string[], flags: GlobalFlags): Promise<void> {
  const verb = args.find((a) => !a.startsWith('--'))
  if (verb === 'on' || verb === 'off') {
    const data = await hubFetch('/pen/stream', { method: 'POST', body: { enabled: verb === 'on' } })
    output(data, flags)
    return
  }
  if (verb === 'status' || verb === undefined) {
    const data = await hubFetch('/pen/stream')
    output(data, flags)
    return
  }
  exitWithError('USAGE', 'Usage: con pen stream on|off|status', flags)
}

// con pen research on       — enable verbose (include heartbeats)
// con pen research off      — minimal (skip heartbeats)
// con pen research tail [N] — print last N entries (default 50)
//
// Unknown opcodes are *always* logged regardless of mode — the toggle only
// controls whether heartbeats pad the log.
async function penResearch(args: string[], flags: GlobalFlags): Promise<void> {
  const verb = args.find((a) => !a.startsWith('--'))
  if (verb === 'on' || verb === 'off') {
    const data = await hubFetch('/pen/research', {
      method: 'POST',
      body: { verbose: verb === 'on' },
    })
    output(data, flags)
    return
  }
  if (verb === 'tail' || verb === undefined) {
    const rest = args.filter((a) => a !== 'tail' && !a.startsWith('--'))
    const n = Number(rest[0] ?? '50') || 50
    const data = await hubFetch(`/pen/research/log?n=${n}`)
    output(data, flags)
    return
  }
  exitWithError('USAGE', 'Usage: con pen research on|off|tail [N]', flags)
}

// con pen offline notes                       — list stored notes on the pen
// con pen offline pages <section> <owner> <note> — list page ids in a note
// con pen offline pull <section> <owner> <note> <page> — rescue one page to disk
// con pen offline files                       — saved .bin files
// con pen offline progress                    — current transfer progress
//
// All non-destructive: the APK forces keep + saves-before-ack; the hub just
// receives the raw bytes and writes them to
// ~/.config/console/pen/offline/<s>-<o>-<n>-<p>.bin as they arrive.
async function penOffline(args: string[], flags: GlobalFlags): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'))
  const sub = positional[0]
  switch (sub) {
    case 'notes': {
      // Trigger enumeration, then (short wait, like scan) read the cache.
      await hubFetch('/pen/offline/notes', { method: 'POST' })
      await sleep(1200)
      const data = await hubFetch('/pen/offline/notes')
      output(data, flags)
      return
    }
    case 'pages': {
      const [, section, owner, note] = positional
      if (section === undefined || owner === undefined || note === undefined) {
        exitWithError('USAGE', 'Usage: con pen offline pages <section> <owner> <note>', flags)
      }
      await hubFetch('/pen/offline/pages', {
        method: 'POST',
        body: { section: Number(section), owner: Number(owner), note: Number(note) },
      })
      await sleep(1200)
      const data = await hubFetch('/pen/offline/pages')
      output(data, flags)
      return
    }
    case 'pull': {
      const [, section, owner, note, page] = positional
      if (section === undefined || owner === undefined || note === undefined || page === undefined) {
        exitWithError('USAGE', 'Usage: con pen offline pull <section> <owner> <note> <page>', flags)
      }
      await hubFetch('/pen/offline/pull', {
        method: 'POST',
        body: {
          section: Number(section),
          owner: Number(owner),
          note: Number(note),
          page: Number(page),
        },
      })
      // Poll progress until the transfer completes (or we time out).
      const opts = parseFlags(args)
      const timeoutMs = Number(opts.timeout ?? '120000') || 120_000
      const start = Date.now()
      let last: PullProgress | null = null
      while (Date.now() - start < timeoutMs) {
        await sleep(750)
        const prog = await hubFetch<PullProgress>('/pen/offline/progress')
        // Only follow the page we asked for; ignore a stale prior transfer.
        const isOurs = prog && prog.page === Number(page) && prog.note === Number(note)
        if (isOurs) {
          last = prog
          const recv = prog.received ?? 0
          const total = prog.totalSize ?? 0
          info(`  ${recv}${total ? `/${total}` : ''} bytes${prog.done ? ' — done' : ''}`)
          if (prog.done) break
        }
      }
      if (!last) {
        exitWithError('TIMEOUT', 'No transfer progress received — is the APK connected and the page valid?', flags)
      }
      output(last, flags)
      return
    }
    case 'files': {
      const data = await hubFetch('/pen/offline/files')
      output(data, flags)
      return
    }
    case 'progress': {
      const data = await hubFetch('/pen/offline/progress')
      output(data, flags)
      return
    }
    default:
      exitWithError(
        'USAGE',
        'Usage: con pen offline notes | pages <section> <owner> <note> | pull <section> <owner> <note> <page> | files | progress',
        flags,
      )
  }
}

interface PullProgress {
  section?: number
  owner?: number
  note?: number
  page?: number
  totalSize?: number
  received?: number
  done?: boolean
  fileSize?: number
  file?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
