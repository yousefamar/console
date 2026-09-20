import { hubFetch } from '../client.js'
import { output, exitWithError, info, outputLine, isJsonMode, type GlobalFlags } from '../output.js'
import { parseFlags, unknownFlags, readStdin } from './util.js'

export async function chat(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'rooms': return chatRooms(args, flags)
    case 'messages': return chatMessages(args, flags)
    case 'send': return chatSend(args, flags)
    case 'send-file': return chatSendFile(args, flags)
    case 'edit': return chatEdit(args, flags)
    case 'react': return chatReact(args, flags)
    case 'mark-read': return chatMarkRead(args, flags)
    case 'mark-unread': return chatMarkUnread(args, flags)
    case 'snooze': return chatSnooze(args, flags)
    case 'draft': return chatDraft(args, flags)
    case 'drafts': return chatDrafts(flags)
    case 'info': return chatInfo(args, flags)
    case 'tail': return chatTail(args, flags)
    case 'undo': return chatUndo(flags)
    default:
      exitWithError('USAGE', `Unknown chat command: ${verb}. Run 'con help chat'.`, flags)
  }
}

async function chatRooms(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch('/matrix/rooms', {
    params: { filter: opts.filter, network: opts.network },
  })
  output(data, flags)
}

type HubMessage = {
  id: string
  sender?: string
  timestamp?: number
  type?: string
  content?: Record<string, unknown>
  decryptFailed?: boolean
}

async function chatMessages(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId) exitWithError('USAGE', 'Usage: con chat messages <room-id>', flags)
  const opts = parseFlags(args.slice(1))
  const data = await hubFetch<{ messages: HubMessage[]; prevBatch?: string }>(`/matrix/rooms/${encodeURIComponent(roomId)}/messages`, {
    params: { limit: opts.limit, before: opts.before },
  })
  if (isJsonMode(flags)) { output(data, flags); return }
  // Oldest first, one line per event, event id leading so it can be pasted
  // straight into `con chat react|edit`.
  for (const m of [...data.messages].reverse()) {
    const when = m.timestamp ? new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ') : ''
    process.stdout.write(`${m.id}  ${when}  ${m.sender ?? ''}  ${messageLine(m)}\n`)
  }
  if (data.prevBatch) info(`older: --before ${data.prevBatch}`)
}

function messageLine(m: HubMessage): string {
  if (m.decryptFailed) return '[undecryptable]'
  const c = m.content ?? {}
  const relates = c['m.relates_to'] as Record<string, unknown> | undefined
  const edited = relates?.rel_type === 'm.replace' ? `(edit of ${String(relates.event_id)}) ` : ''
  const body = typeof c.body === 'string' ? c.body : ''
  const msgtype = typeof c.msgtype === 'string' ? c.msgtype : ''
  if (Object.keys(c).length === 0) return '[redacted]'
  if (msgtype && msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote') return `${edited}[${msgtype}] ${body}`
  if (!msgtype && m.type && m.type !== 'm.room.message') return `[${m.type}]`
  return edited + body.replace(/\s*\n\s*/g, ' ⏎ ')
}

const EDIT_USAGE = 'Usage: con chat edit <room-id> <event-id> --body <text> [--html]'

/** Replace the text of a message WE sent (m.replace). Bridged rooms wait for
 *  the bridge's verdict: WhatsApp only accepts edits inside ~15 minutes and a
 *  refusal is reported as an error even though the Matrix edit landed. */
async function chatEdit(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  const eventId = args[1]
  if (!roomId || !eventId || roomId.startsWith('--') || eventId.startsWith('--')) exitWithError('USAGE', EDIT_USAGE, flags)
  const opts = parseFlags(args.slice(2))
  const bad = unknownFlags(opts, ['body', 'html'])
  if (bad.length) exitWithError('USAGE', `Unknown flag(s): ${bad.map((f) => `--${f}`).join(', ')}. ${EDIT_USAGE}`, flags)
  if (!opts.body) exitWithError('USAGE', `Provide --body. ${EDIT_USAGE}`, flags)

  if (flags.dryRun) { info(`Would edit ${eventId} in ${roomId} to: ${opts.body}`); return }

  const result = await hubFetch<{ event_id: string; bridge?: { status: string; reason?: string; error?: string; network?: string } }>(
    `/matrix/rooms/${encodeURIComponent(roomId)}/edit`,
    { method: 'POST', body: { eventId, body: opts.body, html: opts.html === 'true' } },
  )
  const bridge = result.bridge
  if (bridge && bridge.status !== 'SUCCESS') {
    const detail = [bridge.error, bridge.reason].filter(Boolean).join(', ')
    exitWithError('BRIDGE_REJECTED', `${bridge.network ?? 'bridge'} refused the edit: ${bridge.status}${detail ? ` (${detail})` : ''}. The edit landed on Matrix only (${result.event_id}); the recipient still sees the original.`, flags)
  }
  output(result, flags)
}

async function chatSend(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId) exitWithError('USAGE', 'Usage: con chat send <room-id> --body <text>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.body) exitWithError('USAGE', 'Provide --body', flags)

  if (flags.dryRun) { info(`Would send to ${roomId}: ${opts.body}`); return }

  const result = await hubFetch(`/matrix/rooms/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    body: { body: opts.body, html: opts.html === 'true', replyTo: opts['reply-to'] },
  })
  output(result, flags)
}

async function chatSendFile(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  const filePath = args[1]
  if (!roomId || !filePath) exitWithError('USAGE', 'Usage: con chat send-file <room-id> <file-path> [--caption "..."] [--mime <type>] [--voice]', flags)
  const opts = parseFlags(args.slice(2))
  const bad = unknownFlags(opts, ['caption', 'mime', 'voice'])
  if (bad.length) exitWithError('USAGE', `Unknown flag(s): ${bad.map((f) => `--${f}`).join(', ')}`, flags)
  const voice = opts.voice === 'true'

  if (flags.dryRun) { info(`Would send ${voice ? 'voice note' : 'file'} ${filePath} to ${roomId}`); return }

  const { readFileSync } = await import('node:fs')
  const { basename } = await import('node:path')
  const content = readFileSync(filePath).toString('base64')
  const durationMs = voice ? await audioDurationMs(filePath) : undefined

  const result = await hubFetch(`/matrix/rooms/${encodeURIComponent(roomId)}/send-file`, {
    method: 'POST',
    body: { filename: basename(filePath), content, caption: opts.caption, mimeType: opts.mime, voice, durationMs },
  })
  output(result, flags)
}

/** Voice notes show a length in WhatsApp only if the event carries one; best-effort via ffprobe. */
async function audioDurationMs(filePath: string): Promise<number | undefined> {
  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8' })
    const secs = parseFloat(out.trim())
    return Number.isFinite(secs) ? Math.round(secs * 1000) : undefined
  } catch {
    return undefined
  }
}

async function chatReact(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  const eventId = args[1]
  const emoji = args[2]
  if (!roomId || !eventId || !emoji) exitWithError('USAGE', 'Usage: con chat react <room-id> <event-id> <emoji>', flags)

  const result = await hubFetch(`/matrix/rooms/${encodeURIComponent(roomId)}/react`, {
    method: 'POST',
    body: { eventId, emoji },
  })
  output(result, flags)
}

async function chatMarkRead(args: string[], flags: GlobalFlags): Promise<void> {
  const ids = args.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) exitWithError('USAGE', 'Usage: con chat mark-read <room-id...>', flags)
  for (const id of ids) {
    await hubFetch(`/matrix/rooms/${encodeURIComponent(id)}/read`, { method: 'POST' })
  }
  output({ markedRead: ids }, flags)
}

async function chatMarkUnread(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId) exitWithError('USAGE', 'Usage: con chat mark-unread <room-id>', flags)
  await hubFetch(`/matrix/rooms/${encodeURIComponent(roomId)}/unread`, { method: 'POST' })
  output({ markedUnread: roomId }, flags)
}

async function chatSnooze(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId) exitWithError('USAGE', 'Usage: con chat snooze <room-id> --until <time>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.until) exitWithError('USAGE', 'Provide --until', flags)

  await hubFetch(`/matrix/rooms/${encodeURIComponent(roomId)}/snooze`, {
    method: 'POST',
    body: { until: opts.until },
  })
  output({ snoozed: roomId, until: opts.until }, flags)
}

const DRAFT_USAGE = 'Usage: con chat draft <room-id> [--body <text> | --file <path> | --stdin] [--clear]  (no text = show the current draft)'

/** Leave text in a room's composer WITHOUT sending it. Yousef reviews it in
 *  the chat (the room surfaces as unread while a draft exists) and sends or
 *  discards it himself. */
async function chatDraft(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId || roomId.startsWith('--')) exitWithError('USAGE', DRAFT_USAGE, flags)
  const opts = parseFlags(args.slice(1))
  const bad = unknownFlags(opts, ['body', 'file', 'stdin', 'clear'])
  if (bad.length) exitWithError('USAGE', `Unknown flag(s): ${bad.map((f) => `--${f}`).join(', ')}. ${DRAFT_USAGE}`, flags)
  const path = `/matrix/rooms/${encodeURIComponent(roomId)}/draft`

  if (opts.clear === 'true') {
    if (flags.dryRun) { info(`Would clear the draft in ${roomId}`); return }
    output(await hubFetch(path, { method: 'DELETE' }), flags)
    return
  }

  let text = opts.body
  if (text === undefined && opts.file) {
    const { readFileSync } = await import('node:fs')
    text = readFileSync(opts.file, 'utf8')
  }
  if (text === undefined && opts.stdin === 'true') text = await readStdin()
  if (text === undefined) {
    // No text at all = show the current draft.
    output(await hubFetch(path), flags)
    return
  }
  text = text.replace(/\s+$/, '')
  if (!text) exitWithError('USAGE', `Draft text is empty. ${DRAFT_USAGE}`, flags)

  if (flags.dryRun) { info(`Would draft in ${roomId} (not send): ${text}`); return }
  output(await hubFetch(path, { method: 'PUT', body: { text } }), flags)
}

async function chatDrafts(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/matrix/drafts'), flags)
}

async function chatInfo(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId) exitWithError('USAGE', 'Usage: con chat info <room-id>', flags)
  const data = await hubFetch(`/matrix/rooms/${encodeURIComponent(roomId)}/info`)
  output(data, flags)
}

async function chatTail(args: string[], flags: GlobalFlags): Promise<void> {
  const roomId = args[0]
  if (!roomId) exitWithError('USAGE', 'Usage: con chat tail <room-id>', flags)

  // Connect to hub WebSocket and stream messages
  const { connectAndStream } = await import('../ws-client.js')
  await connectAndStream({
    filter: (msg: any) => msg.type === 'matrix_event' && msg.roomId === roomId,
    onMessage: (msg: any) => outputLine(msg),
  })
}

async function chatUndo(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/matrix/undo', { method: 'POST' })
  output(data, flags)
}
