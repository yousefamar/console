// con glasses — control the G1 smart glasses through the hub.
//
// All commands go: CLI → hub (/glasses/*) → APK PushService → BLE → G1.
// If the APK isn't connected on /push, the hub answers 503 and we surface a
// clear error. See `docs/g1-protocol.md` for the overall topology.

import { readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags, readStdin } from './util.js'

export async function glasses(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return glassesStatus(flags)
    case 'text': return glassesText(args, flags)
    case 'clear': return glassesClear(flags)
    case 'bmp': return glassesBmp(args, flags)
    case 'notify': return glassesNotify(args, flags)
    case 'mic': return glassesMic(args, flags)
    case 'disconnect': return glassesDisconnect(flags)
    case 'scan': return glassesScan(args, flags)
    case 'research': return glassesResearch(args, flags)
    case 'hud': return glassesHud(args, flags)
    case 'config': return glassesConfig(args, flags)
    default:
      exitWithError('USAGE', `Unknown glasses command: ${verb}. Run 'con help glasses'.`, flags)
  }
}

async function glassesStatus(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/glasses/status')
  output(data, flags)
}

async function glassesText(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  // Positional fallback: `con glasses text "Hello"`
  const positional = args.find((a) => !a.startsWith('--'))
  let text = opts.text ?? positional
  if (opts.stdin === 'true') text = (await readStdin()).trimEnd()
  if (!text) exitWithError('USAGE', 'Usage: con glasses text "<text>" | --text "<text>" | --stdin', flags)
  const data = await hubFetch('/glasses/text', { method: 'POST', body: { text } })
  output(data, flags)
}

async function glassesClear(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/glasses/clear', { method: 'POST' })
  output(data, flags)
}

async function glassesBmp(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const filePositional = args.find((a) => !a.startsWith('--'))
  const file = opts.file ?? filePositional
  if (!file) exitWithError('USAGE', 'Usage: con glasses bmp <path.bmp> | --file <path>', flags)
  let bmpB64: string
  try {
    const buf = readFileSync(file)
    bmpB64 = buf.toString('base64')
  } catch (err) {
    exitWithError('USAGE', `Could not read ${file}: ${(err as Error).message}`, flags)
    return
  }
  const data = await hubFetch('/glasses/bmp', { method: 'POST', body: { bmp: bmpB64 }, timeout: 30_000 })
  output(data, flags)
}

async function glassesNotify(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.title && !opts.message) {
    exitWithError('USAGE', 'Usage: con glasses notify --title "<t>" [--subtitle "<s>"] [--message "<m>"] [--app com.example]', flags)
  }
  const body = {
    // Must match a whitelisted id (default io.amar.console) or firmware drops it.
    appIdentifier: opts.app ?? 'io.amar.console',
    displayName: opts.source,
    title: opts.title ?? '',
    subtitle: opts.subtitle ?? '',
    message: opts.message ?? '',
    timestamp: Date.now(),
  }
  const data = await hubFetch('/glasses/notify', { method: 'POST', body })
  output(data, flags)
}

async function glassesMic(args: string[], flags: GlobalFlags): Promise<void> {
  const positional = args.find((a) => !a.startsWith('--'))
  const state = positional ?? parseFlags(args).state
  if (state !== 'on' && state !== 'off') {
    exitWithError('USAGE', 'Usage: con glasses mic on|off', flags)
  }
  const data = await hubFetch('/glasses/mic', { method: 'POST', body: { active: state === 'on' } })
  output(data, flags)
}

async function glassesDisconnect(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/glasses/disconnect', { method: 'POST' })
  output(data, flags)
}

// con glasses hud on|off            — toggle the idle head-tilt HUD
async function glassesHud(args: string[], flags: GlobalFlags): Promise<void> {
  const positional = args.find((a) => !a.startsWith('--'))
  const state = positional ?? parseFlags(args).state
  if (state !== 'on' && state !== 'off') {
    exitWithError('USAGE', 'Usage: con glasses hud on|off', flags)
  }
  const data = await hubFetch('/glasses/config', { method: 'POST', body: { hudEnabled: state === 'on' } })
  output(data, flags)
}

// con glasses config                              — show current config
// con glasses config --notify on|off              — master notification toggle
// con glasses config --channel <name> on|off      — per-source opt-out
// con glasses config --angle <0-60>               — head-up tilt threshold
async function glassesConfig(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const patch: Record<string, unknown> = {}
  if (opts.notify === 'on' || opts.notify === 'off') patch.notifyEnabled = opts.notify === 'on'
  if (opts.angle != null) patch.headUpAngleDeg = Number(opts.angle)
  if (opts.channel) {
    // Shape: --channel mail off  (value is the channel; on/off is positional)
    const onoff = args.find((a) => a === 'on' || a === 'off')
    if (onoff !== 'on' && onoff !== 'off') {
      exitWithError('USAGE', 'Usage: con glasses config --channel <mail|chat|calendar|agent|money> on|off', flags)
    }
    patch.channels = { [opts.channel]: onoff === 'on' }
  }
  // No patch flags → just read+print the current config.
  const data = Object.keys(patch).length === 0
    ? await hubFetch('/glasses/config')
    : await hubFetch('/glasses/config', { method: 'POST', body: patch })
  output(data, flags)
}

// con glasses scan start [--ms N]   — trigger a BLE scan on the phone
// con glasses scan stop             — halt the in-flight scan
// con glasses scan observations     — dump every named advert seen recently
//
// Useful for debugging "scan finds no glasses": the observations endpoint
// shows what names are actually advertising, regardless of whether they
// match the G1 regex.
async function glassesScan(args: string[], flags: GlobalFlags): Promise<void> {
  const verb = args.find((a) => !a.startsWith('--')) ?? 'start'
  if (verb === 'start') {
    const opts = parseFlags(args)
    const durationMs = Number(opts.ms ?? '15000') || 15000
    const data = await hubFetch('/glasses/scan', { method: 'POST', body: { durationMs } })
    output(data, flags)
    return
  }
  if (verb === 'stop') {
    const data = await hubFetch('/glasses/scan/stop', { method: 'POST' })
    output(data, flags)
    return
  }
  if (verb === 'observations' || verb === 'obs') {
    const data = await hubFetch('/glasses/scan/observations')
    output(data, flags)
    return
  }
  exitWithError('USAGE', 'Usage: con glasses scan start [--ms N] | stop | observations', flags)
}

// con glasses research on       — enable verbose (include heartbeats)
// con glasses research off      — minimal (skip heartbeats)
// con glasses research tail [N] — print last N entries (default 50)
//
// Unknown opcodes are *always* logged regardless of mode — the toggle only
// controls whether heartbeats pad the log.
async function glassesResearch(args: string[], flags: GlobalFlags): Promise<void> {
  const verb = args.find((a) => !a.startsWith('--'))
  if (verb === 'on' || verb === 'off') {
    const data = await hubFetch('/glasses/research', {
      method: 'POST',
      body: { verbose: verb === 'on' },
    })
    output(data, flags)
    return
  }
  if (verb === 'tail' || verb === undefined) {
    const rest = args.filter((a) => a !== 'tail' && !a.startsWith('--'))
    const n = Number(rest[0] ?? '50') || 50
    const data = await hubFetch(`/glasses/research/log?n=${n}`)
    output(data, flags)
    return
  }
  exitWithError('USAGE', 'Usage: con glasses research on|off|tail [N]', flags)
}
