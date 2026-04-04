import { hubFetch } from '../client.js'
import { output, exitWithError, info, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function bookmarks(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return bookmarksList(args, flags)
    case 'get': return bookmarksGet(args, flags)
    case 'tags': return bookmarksTags(flags)
    case 'update': return bookmarksUpdate(args, flags)
    case 'delete': return bookmarksDelete(args, flags)
    case 'reload': return bookmarksReload(flags)
    default:
      exitWithError('USAGE', `Unknown bookmarks command: ${verb}. Run 'con help bookmarks'.`, flags)
  }
}

async function bookmarksList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch<unknown[]>('/bookmarks')

  let items = data
  // Client-side filtering
  if (opts.tag) {
    items = items.filter((b: any) => b.tags?.some((t: string) => t === opts.tag || t.startsWith(opts.tag + '/')))
  }
  if (opts.search || opts.q) {
    const q = (opts.search || opts.q || '').toLowerCase()
    items = items.filter((b: any) =>
      b.title?.toLowerCase().includes(q) || b.url?.toLowerCase().includes(q) || b.description?.toLowerCase().includes(q),
    )
  }
  if (opts.limit) {
    items = items.slice(0, parseInt(opts.limit, 10))
  }

  output(items, flags)
}

async function bookmarksGet(args: string[], flags: GlobalFlags): Promise<void> {
  const filename = args[0]
  if (!filename) exitWithError('USAGE', 'Usage: con bookmarks get <filename>', flags)
  const data = await hubFetch(`/bookmarks/${encodeURIComponent(filename)}`)
  output(data, flags)
}

async function bookmarksTags(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/bookmarks/tags')
  output(data, flags)
}

async function bookmarksUpdate(args: string[], flags: GlobalFlags): Promise<void> {
  const filename = args[0]
  if (!filename) exitWithError('USAGE', 'Usage: con bookmarks update <filename> [--add-tag <t>] [--remove-tag <t>] [--title <t>]', flags)

  const opts = parseFlags(args.slice(1))
  const body: Record<string, unknown> = {}

  // Get current bookmark to modify tags
  const current = await hubFetch<any>(`/bookmarks/${encodeURIComponent(filename)}`)
  let tags: string[] = current.tags || []

  if (opts['add-tag']) {
    const toAdd = opts['add-tag'].split(',').map((t: string) => t.trim())
    tags = [...new Set([...tags, ...toAdd])]
  }
  if (opts['remove-tag']) {
    const toRemove = opts['remove-tag'].split(',').map((t: string) => t.trim())
    tags = tags.filter((t) => !toRemove.includes(t))
  }

  body.tags = tags
  if (opts.title) body.title = opts.title

  if (flags.dryRun) {
    info(`Would update ${filename}: ${JSON.stringify(body)}`)
    return
  }

  await hubFetch(`/bookmarks/${encodeURIComponent(filename)}`, { method: 'PUT', body })
  output({ updated: filename, ...body }, flags)
}

async function bookmarksDelete(args: string[], flags: GlobalFlags): Promise<void> {
  const filename = args[0]
  if (!filename) exitWithError('USAGE', 'Usage: con bookmarks delete <filename>', flags)

  if (flags.dryRun) {
    info(`Would delete ${filename}`)
    return
  }

  await hubFetch(`/bookmarks/${encodeURIComponent(filename)}`, { method: 'DELETE' })
  output({ deleted: filename }, flags)
}

async function bookmarksReload(flags: GlobalFlags): Promise<void> {
  await hubFetch('/bookmarks/reload', { method: 'POST' })
  output({ reloaded: true }, flags)
}
