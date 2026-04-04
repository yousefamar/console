import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function search(args: string[], flags: GlobalFlags): Promise<void> {
  const query = args.filter((a) => !a.startsWith('--'))[0]
  if (!query) exitWithError('USAGE', 'Usage: con search <query> [--scope mail,notes,...] [--limit <n>]', flags)

  const opts = parseFlags(args)
  const scopes = (opts.scope || 'mail,chat,notes,bookmarks,feeds').split(',')
  const limit = parseInt(opts.limit || '10', 10)

  const results: Record<string, unknown[]> = {}

  // Search each service in parallel
  const searches = scopes.map(async (scope) => {
    try {
      switch (scope.trim()) {
        case 'mail': {
          const data = await hubFetch<any>('/mail/threads', {
            params: { q: query, maxResults: String(limit) },
          })
          results.mail = data.threads || data || []
          break
        }
        case 'notes': {
          const files = await hubFetch<Array<{ path: string; name: string }>>('/notes')
          const q = query.toLowerCase()
          results.notes = files
            .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
            .slice(0, limit)
          break
        }
        case 'bookmarks': {
          const data = await hubFetch<unknown[]>('/bookmarks')
          const q = query.toLowerCase()
          results.bookmarks = (data as any[])
            .filter((b) => b.title?.toLowerCase().includes(q) || b.url?.toLowerCase().includes(q))
            .slice(0, limit)
          break
        }
        case 'feeds': {
          const items = await hubFetch<unknown[]>('/feeds/items')
          const q = query.toLowerCase()
          results.feeds = (items as any[])
            .filter((i) => i.title?.toLowerCase().includes(q) || i.contentSnippet?.toLowerCase().includes(q))
            .slice(0, limit)
          break
        }
        case 'chat': {
          // Chat search would require Matrix search API — return empty for now
          results.chat = []
          break
        }
      }
    } catch {
      results[scope.trim()] = []
    }
  })

  await Promise.all(searches)
  output(results, flags)
}
