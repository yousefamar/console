import { readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, info, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function feeds(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return feedsList(args, flags)
    case 'items': return feedsItems(args, flags)
    case 'read': return feedsRead(args, flags)
    case 'mark-read': return feedsMarkRead(args, flags)
    case 'mark-unread': return feedsMarkUnread(args, flags)
    case 'add': return feedsAdd(args, flags)
    case 'delete': return feedsDelete(args, flags)
    case 'import': return feedsImport(args, flags)
    case 'export': return feedsExport(args, flags)
    default:
      exitWithError('USAGE', `Unknown feeds command: ${verb}. Run 'con help feeds'.`, flags)
  }
}

async function feedsList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  let data = await hubFetch<unknown[]>('/feeds')

  if (opts.folder) {
    data = data.filter((f: any) => f.folder === opts.folder)
  }

  output(data, flags)
}

async function feedsItems(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const params: Record<string, string | undefined> = {}

  if (opts.since) params.since = opts.since

  // If specific feed, fetch that feed's items
  const feedPath = opts.feed ? `/feeds/${encodeURIComponent(opts.feed)}/items` : '/feeds/items'
  let items = await hubFetch<unknown[]>(feedPath, { params })

  // Get read state for filtering
  if (opts.unread) {
    const readState = await hubFetch<{ read: string[] }>('/feeds/read')
    const readSet = new Set(readState.read || [])
    items = items.filter((item: any) => !readSet.has(item.id))
  }

  // Folder filter (client-side)
  if (opts.folder) {
    const feedList = await hubFetch<Array<{ id: string; folder?: string }>>('/feeds')
    const folderFeeds = new Set(feedList.filter((f) => f.folder === opts.folder).map((f) => f.id))
    items = items.filter((item: any) => folderFeeds.has(item.feedId))
  }

  if (opts.limit) {
    items = items.slice(0, parseInt(opts.limit, 10))
  }

  output(items, flags)
}

async function feedsRead(args: string[], flags: GlobalFlags): Promise<void> {
  const itemId = args[0]
  if (!itemId) exitWithError('USAGE', 'Usage: con feeds read <item-id>', flags)

  // Fetch all items and find the one we want
  const items = await hubFetch<unknown[]>('/feeds/items')
  const item = (items as any[]).find((i) => i.id === itemId)

  if (!item) exitWithError('NOT_FOUND', `Feed item not found: ${itemId}`, flags)
  output(item, flags)
}

async function feedsMarkRead(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)

  if (opts.all) {
    // Mark everything read
    const items = await hubFetch<unknown[]>('/feeds/items')
    const ids = (items as any[]).map((i) => i.id)
    await hubFetch('/feeds/read', { method: 'PUT', body: { add: ids, remove: [] } })
    output({ markedRead: ids.length }, flags)
    return
  }

  if (opts.feed) {
    // Mark all items in a feed as read
    const items = await hubFetch<unknown[]>(`/feeds/${encodeURIComponent(opts.feed)}/items`)
    const ids = (items as any[]).map((i) => i.id)
    await hubFetch('/feeds/read', { method: 'PUT', body: { add: ids, remove: [] } })
    output({ markedRead: ids.length, feed: opts.feed }, flags)
    return
  }

  if (opts.item) {
    await hubFetch('/feeds/read', { method: 'PUT', body: { add: [opts.item], remove: [] } })
    output({ markedRead: 1, item: opts.item }, flags)
    return
  }

  // Positional arg
  const itemId = args[0]
  if (itemId && !itemId.startsWith('--')) {
    await hubFetch('/feeds/read', { method: 'PUT', body: { add: [itemId], remove: [] } })
    output({ markedRead: 1, item: itemId }, flags)
    return
  }

  exitWithError('USAGE', 'Usage: con feeds mark-read [--item <id>] [--feed <id>] [--all]', flags)
}

async function feedsMarkUnread(args: string[], flags: GlobalFlags): Promise<void> {
  const itemId = args[0]
  if (!itemId) exitWithError('USAGE', 'Usage: con feeds mark-unread <item-id>', flags)

  await hubFetch('/feeds/read', { method: 'PUT', body: { add: [], remove: [itemId] } })
  output({ markedUnread: itemId }, flags)
}

async function feedsAdd(args: string[], flags: GlobalFlags): Promise<void> {
  const url = args[0]
  if (!url) exitWithError('USAGE', 'Usage: con feeds add <url> [--title <t>] [--folder <f>] [--full-text]', flags)

  const opts = parseFlags(args.slice(1))
  const body: Record<string, unknown> = { xmlUrl: url }
  if (opts.title) body.title = opts.title
  if (opts.folder) body.folder = opts.folder
  if (opts['full-text']) body.fullText = true

  if (flags.dryRun) {
    info(`Would subscribe to ${url}`)
    return
  }

  const result = await hubFetch('/feeds', { method: 'POST', body })
  output(result, flags)
}

async function feedsDelete(args: string[], flags: GlobalFlags): Promise<void> {
  const feedId = args[0]
  if (!feedId) exitWithError('USAGE', 'Usage: con feeds delete <feed-id>', flags)

  if (flags.dryRun) {
    info(`Would unsubscribe from ${feedId}`)
    return
  }

  await hubFetch(`/feeds/${encodeURIComponent(feedId)}`, { method: 'DELETE' })
  output({ deleted: feedId }, flags)
}

async function feedsImport(args: string[], flags: GlobalFlags): Promise<void> {
  const filePath = args[0]
  if (!filePath) exitWithError('USAGE', 'Usage: con feeds import <opml-file>', flags)

  const opml = readFileSync(filePath, 'utf8')

  if (flags.dryRun) {
    info(`Would import OPML from ${filePath}`)
    return
  }

  const result = await hubFetch('/feeds/import-opml', { method: 'POST', body: { opml } })
  output(result, flags)
}

async function feedsExport(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch<string>('/feeds/export-opml')

  if (opts.out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(opts.out, typeof data === 'string' ? data : JSON.stringify(data))
    info(`Exported to ${opts.out}`)
  } else {
    process.stdout.write(typeof data === 'string' ? data : JSON.stringify(data))
    process.stdout.write('\n')
  }
}
