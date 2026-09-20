// con whatsapp — drive Al's absorbed Baileys integration via the hub.
//
//   con whatsapp status                        → connection + QR state
//   con whatsapp qr                            → write QR PNG to stdout / file
//   con whatsapp send <to> [--body | --file]   → outbound text
//   con whatsapp send <to> --speak "…" [--lang ar] [--speed 1.1]
//                                              → voice note in Yousef's cloned voice (Cartesia)
//   con whatsapp send <to> --audio <file>      → any audio file, sent as a voice note
//   con whatsapp delete <message_id> --to <jid> → revoke for everyone
//   con whatsapp contacts [--query <text>]     → workspace contacts lookup
//   con whatsapp call <to> --task "…"          → AL phones <to> on WhatsApp (Yousef's voice, full context)
//   con whatsapp calls [--last N] [--live]     → calls in progress (live transcript so far), then recent transcripts
//   con whatsapp hangup <callId>               → end a live call (after the current sentence finishes)
//   con whatsapp voice [--qr <path.png>]       → voice device (wa-voice) + pipeline status + live call; QR when unpaired
//
// `to` accepts a bare phone (`447700900123`) or a fully-qualified JID
// (`447700900123@s.whatsapp.net`, `<lid>@lid`, `<id>@g.us`). Bare phones get
// `@s.whatsapp.net` appended on the hub side.

import { writeFileSync, readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags, readStdin } from './util.js'

export async function whatsapp(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return waStatus(flags)
    case 'qr': return waQr(args, flags)
    case 'send': return waSend(args, flags)
    case 'delete': return waDelete(args, flags)
    case 'contacts': return waContacts(args, flags)
    case 'call': return waCall(args, flags)
    case 'calls': return waCalls(args, flags)
    case 'hangup': return waHangup(args, flags)
    case 'voice': return waVoice(args, flags)
    default:
      exitWithError('USAGE', `Unknown whatsapp command: ${verb}. Run 'con help whatsapp'.`, flags)
  }
}

async function waStatus(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/whatsapp/status')
  output(data, flags)
}

async function waQr(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const out = opts.out
  const res = await hubFetch<Response>('/whatsapp/qr', { raw: true })
  if (!res.ok) {
    exitWithError('NOT_FOUND', `WhatsApp QR not available (status ${res.status}).`, flags)
    return
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (out) {
    writeFileSync(out, buf)
    output({ ok: true, path: out, bytes: buf.length }, flags)
  } else {
    process.stdout.write(buf)
  }
}

async function waSend(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const to = (args.find((a) => !a.startsWith('--')) ?? opts.to ?? '').trim()
  if (!to) exitWithError('USAGE', 'Usage: con whatsapp send <to> [--body "..." | --file <path> | --stdin]', flags)

  if (opts.speak) {
    const speed = opts.speed ? Number(opts.speed) : undefined
    if (speed !== undefined && !(speed >= 0.6 && speed <= 1.5)) exitWithError('USAGE', '--speed must be between 0.6 and 1.5', flags)
    const data = await hubFetch('/whatsapp/send', { method: 'POST', body: { to, speak: opts.speak, language: opts.lang, speed } })
    return output(data, flags)
  }
  if (opts.audio) {
    let audio: string
    try { audio = readFileSync(opts.audio).toString('base64') }
    catch (err) { return exitWithError('USAGE', `Could not read ${opts.audio}: ${(err as Error).message}`, flags) }
    const data = await hubFetch('/whatsapp/send', { method: 'POST', body: { to, audio } })
    return output(data, flags)
  }

  let body = opts.body
  if (!body && opts.file) {
    try { body = readFileSync(opts.file, 'utf-8') }
    catch (err) { exitWithError('USAGE', `Could not read ${opts.file}: ${(err as Error).message}`, flags) }
  }
  if (!body && opts.stdin === 'true') body = await readStdin()
  if (!body || !body.trim()) {
    exitWithError('USAGE', 'Provide --body "...", --file <path>, --stdin, --speak "..." or --audio <file>', flags)
  }

  const data = await hubFetch('/whatsapp/send', { method: 'POST', body: { to, text: body } })
  output(data, flags)
}

async function waDelete(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const messageId = (args.find((a) => !a.startsWith('--')) ?? opts.message_id ?? '').trim()
  const to = (opts.to ?? '').trim()
  if (!messageId || !to) {
    exitWithError('USAGE', 'Usage: con whatsapp delete <message_id> --to <jid>', flags)
  }
  const data = await hubFetch('/whatsapp/delete', { method: 'POST', body: { to, messageId } })
  output(data, flags)
}

async function waContacts(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const query = opts.query ? `?query=${encodeURIComponent(opts.query)}` : ''
  const data = await hubFetch(`/whatsapp/contacts${query}`)
  output(data, flags)
}

async function waCall(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const to = (args.find((a) => !a.startsWith('--')) ?? opts.to ?? '').trim()
  const task = (opts.task ?? '').trim()
  if (!to || !task) exitWithError('USAGE', 'Usage: con whatsapp call <phone|jid|slug> --task "why you are calling and what to achieve"', flags)
  const data = await hubFetch('/voice/call', { method: 'POST', body: { to, task } })
  output(data, flags)
}

async function waCalls(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const limit = Number(opts.last ?? opts.limit ?? 20)
  const data = await hubFetch<{ live?: unknown[]; calls?: unknown[] }>(`/voice/calls?limit=${Number.isFinite(limit) && limit > 0 ? limit : 20}`)
  if (opts.live !== undefined) return output({ live: data.live ?? [] }, flags)
  output(data, flags)
}

async function waHangup(args: string[], flags: GlobalFlags): Promise<void> {
  const callId = (args.find((a) => !a.startsWith('--')) ?? '').trim()
  if (!callId) exitWithError('USAGE', 'Usage: con whatsapp hangup <callId>   (con whatsapp calls --live lists them)', flags)
  const data = await hubFetch('/voice/hangup', { method: 'POST', body: { callId } })
  output(data, flags)
}

async function waVoice(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (opts.qr !== undefined) {
    const res = await hubFetch<Response>('/voice/qr', { raw: true })
    if (!res.ok) {
      exitWithError('NOT_FOUND', `No voice-device QR (status ${res.status}) — wa-voice is paired, down, or not yet asking.`, flags)
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (typeof opts.qr === 'string' && opts.qr !== 'true') {
      writeFileSync(opts.qr, buf)
      return output({ ok: true, path: opts.qr, bytes: buf.length }, flags)
    }
    process.stdout.write(buf)
    return
  }
  const data = await hubFetch('/voice/status')
  output(data, flags)
}
