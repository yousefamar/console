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
