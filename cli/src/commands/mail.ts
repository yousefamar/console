import { hubFetch } from '../client.js'
import { output, exitWithError, info, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function mail(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return mailList(args, flags)
    case 'read': return mailRead(args, flags)
    case 'archive': return mailArchive(args, flags)
    case 'trash': return mailTrash(args, flags)
    case 'snooze': return mailSnooze(args, flags)
    case 'unsnooze': return mailUnsnooze(args, flags)
    case 'mark-read': return mailMarkRead(args, flags)
    case 'mark-unread': return mailMarkUnread(args, flags)
    case 'reply': return mailReply(args, flags)
    case 'forward': return mailForward(args, flags)
    case 'send': return mailSend(args, flags)
    case 'attachments': return mailAttachments(args, flags)
    case 'download': return mailDownload(args, flags)
    case 'contacts': return mailContacts(args, flags)
    case 'aliases': return mailAliases(flags)
    case 'undo': return mailUndo(flags)
    default:
      exitWithError('USAGE', `Unknown mail command: ${verb}. Run 'con help mail'.`, flags)
  }
}

async function mailList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch('/mail/threads', {
    params: {
      q: opts.query || opts.q,
      maxResults: opts.max,
      pageToken: opts['page-token'],
    },
  })
  output(data, flags)
}

async function mailRead(args: string[], flags: GlobalFlags): Promise<void> {
  const threadId = args[0]
  if (!threadId) exitWithError('USAGE', 'Usage: con mail read <thread-id>', flags)
  const opts = parseFlags(args.slice(1))
  const data = await hubFetch(`/mail/threads/${threadId}`, {
    params: { format: opts.format },
  })
  output(data, flags)
}

async function mailArchive(args: string[], flags: GlobalFlags): Promise<void> {
  const ids = args.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) exitWithError('USAGE', 'Usage: con mail archive <thread-id...>', flags)
  if (flags.dryRun) { info(`Would archive: ${ids.join(', ')}`); return }
  for (const id of ids) {
    await hubFetch(`/mail/threads/${id}/archive`, { method: 'POST' })
  }
  output({ archived: ids }, flags)
}

async function mailTrash(args: string[], flags: GlobalFlags): Promise<void> {
  const ids = args.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) exitWithError('USAGE', 'Usage: con mail trash <thread-id...>', flags)
  if (flags.dryRun) { info(`Would trash: ${ids.join(', ')}`); return }
  for (const id of ids) {
    await hubFetch(`/mail/threads/${id}/trash`, { method: 'POST' })
  }
  output({ trashed: ids }, flags)
}

async function mailSnooze(args: string[], flags: GlobalFlags): Promise<void> {
  const threadId = args[0]
  if (!threadId) exitWithError('USAGE', 'Usage: con mail snooze <thread-id> --until <time>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.until) exitWithError('USAGE', 'Provide --until (later-today, tomorrow, next-week, monday, or ISO date)', flags)
  if (flags.dryRun) { info(`Would snooze ${threadId} until ${opts.until}`); return }
  await hubFetch(`/mail/threads/${threadId}/snooze`, { method: 'POST', body: { until: opts.until } })
  output({ snoozed: threadId, until: opts.until }, flags)
}

async function mailUnsnooze(args: string[], flags: GlobalFlags): Promise<void> {
  const threadId = args[0]
  if (!threadId) exitWithError('USAGE', 'Usage: con mail unsnooze <thread-id>', flags)
  await hubFetch(`/mail/threads/${threadId}/unsnooze`, { method: 'POST' })
  output({ unsnoozed: threadId }, flags)
}

async function mailMarkRead(args: string[], flags: GlobalFlags): Promise<void> {
  const ids = args.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) exitWithError('USAGE', 'Usage: con mail mark-read <thread-id...>', flags)
  for (const id of ids) {
    await hubFetch(`/mail/threads/${id}/read`, { method: 'POST' })
  }
  output({ markedRead: ids }, flags)
}

async function mailMarkUnread(args: string[], flags: GlobalFlags): Promise<void> {
  const ids = args.filter((a) => !a.startsWith('--'))
  if (ids.length === 0) exitWithError('USAGE', 'Usage: con mail mark-unread <thread-id...>', flags)
  for (const id of ids) {
    await hubFetch(`/mail/threads/${id}/unread`, { method: 'POST' })
  }
  output({ markedUnread: ids }, flags)
}

async function mailReply(args: string[], flags: GlobalFlags): Promise<void> {
  const threadId = args[0]
  if (!threadId) exitWithError('USAGE', 'Usage: con mail reply <thread-id> --body <text>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.body) exitWithError('USAGE', 'Provide --body', flags)
  if (flags.dryRun) { info(`Would reply to ${threadId}`); return }
  const result = await hubFetch('/mail/reply', {
    method: 'POST',
    body: {
      threadId,
      body: opts.body,
      html: opts.html === 'true',
      replyAll: opts['reply-all'] === 'true',
      cc: opts.cc,
    },
  })
  output(result, flags)
}

async function mailForward(args: string[], flags: GlobalFlags): Promise<void> {
  const threadId = args[0]
  if (!threadId) exitWithError('USAGE', 'Usage: con mail forward <thread-id> --to <addr>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.to) exitWithError('USAGE', 'Provide --to', flags)
  if (flags.dryRun) { info(`Would forward ${threadId} to ${opts.to}`); return }
  const result = await hubFetch('/mail/forward', {
    method: 'POST',
    body: { threadId, to: opts.to, body: opts.body },
  })
  output(result, flags)
}

async function mailSend(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.to || !opts.subject || !opts.body) {
    exitWithError('USAGE', 'Usage: con mail send --to <addr> --subject <s> --body <text>', flags)
  }
  if (flags.dryRun) { info(`Would send email to ${opts.to}: ${opts.subject}`); return }

  const body: Record<string, unknown> = {
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    html: opts.html === 'true',
  }
  if (opts.cc) body.cc = opts.cc
  if (opts.from) body.from = opts.from

  // Handle file attachments
  if (opts.attach) {
    const { readFileSync } = await import('node:fs')
    const { basename } = await import('node:path')
    const files = opts.attach.split(',')
    body.attachments = files.map((f: string) => ({
      filename: basename(f.trim()),
      content: readFileSync(f.trim()).toString('base64'),
    }))
  }

  const result = await hubFetch('/mail/send', { method: 'POST', body })
  output(result, flags)
}

async function mailAttachments(args: string[], flags: GlobalFlags): Promise<void> {
  const threadId = args[0]
  if (!threadId) exitWithError('USAGE', 'Usage: con mail attachments <thread-id>', flags)
  const data = await hubFetch(`/mail/threads/${threadId}/attachments`)
  output(data, flags)
}

async function mailDownload(args: string[], flags: GlobalFlags): Promise<void> {
  const messageId = args[0]
  const attachmentId = args[1]
  if (!messageId || !attachmentId) exitWithError('USAGE', 'Usage: con mail download <message-id> <attachment-id> [--out <path>]', flags)
  const opts = parseFlags(args.slice(2))
  const data = await hubFetch<{ data: string; filename?: string }>(`/mail/messages/${messageId}/attachments/${attachmentId}`)

  if (opts.out || data.filename) {
    const { writeFileSync } = await import('node:fs')
    const outPath = opts.out || data.filename || 'attachment'
    writeFileSync(outPath, Buffer.from(data.data, 'base64url'))
    output({ downloaded: outPath }, flags)
  } else {
    output(data, flags)
  }
}

async function mailContacts(args: string[], flags: GlobalFlags): Promise<void> {
  const query = args[0]
  if (!query) exitWithError('USAGE', 'Usage: con mail contacts <query>', flags)
  const data = await hubFetch('/mail/contacts', { params: { q: query } })
  output(data, flags)
}

async function mailAliases(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/mail/aliases')
  output(data, flags)
}

async function mailUndo(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/mail/undo', { method: 'POST' })
  output(data, flags)
}
