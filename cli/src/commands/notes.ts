import { readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, info, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function notes(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return notesList(args, flags)
    case 'read': return notesRead(args, flags)
    case 'write': return notesWrite(args, flags)
    case 'append': return notesAppend(args, flags)
    case 'delete': return notesDelete(args, flags)
    case 'rename': return notesRename(args, flags)
    case 'mkdir': return notesMkdir(args, flags)
    case 'search': return notesSearch(args, flags)
    case 'daily': return notesDaily(args, flags)
    default:
      exitWithError('USAGE', `Unknown notes command: ${verb}. Run 'con help notes'.`, flags)
  }
}

async function notesList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch<unknown[]>('/notes')

  let items = data
  if (opts.dir) {
    items = items.filter((f: any) => f.path.startsWith(opts.dir + '/') || f.dir === opts.dir)
  }

  output(items, flags)
}

async function notesRead(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0]
  if (!path) exitWithError('USAGE', 'Usage: con notes read <path>', flags)
  const data = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(path)}`)
  if (flags.json || flags.agent || !process.stdout.isTTY) {
    output(data, flags)
  } else {
    process.stdout.write(data.content ?? String(data))
    process.stdout.write('\n')
  }
}

async function notesWrite(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0]
  if (!path) exitWithError('USAGE', 'Usage: con notes write <path> --content <text> | --stdin', flags)

  const opts = parseFlags(args.slice(1))
  let content = opts.content

  if (opts.stdin) {
    content = readFileSync('/dev/stdin', 'utf8')
  }

  if (content === undefined) exitWithError('USAGE', 'Provide --content or --stdin', flags)

  if (flags.dryRun) {
    info(`Would write ${path} (${content.length} chars)`)
    return
  }

  await hubFetch(`/notes/file/${encodeURIComponent(path)}`, { method: 'PUT', body: { content } })
  output({ written: path, length: content.length }, flags)
}

async function notesAppend(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0]
  if (!path) exitWithError('USAGE', 'Usage: con notes append <path> --content <text>', flags)

  const opts = parseFlags(args.slice(1))
  if (!opts.content) exitWithError('USAGE', 'Provide --content', flags)

  // Read current content, append, write back
  const current = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(path)}`).catch(() => ({ content: '' }))
  const newContent = (current.content || '') + '\n' + opts.content

  if (flags.dryRun) {
    info(`Would append ${opts.content.length} chars to ${path}`)
    return
  }

  await hubFetch(`/notes/file/${encodeURIComponent(path)}`, { method: 'PUT', body: { content: newContent } })
  output({ appended: path, addedLength: opts.content.length }, flags)
}

async function notesDelete(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0]
  if (!path) exitWithError('USAGE', 'Usage: con notes delete <path>', flags)

  if (flags.dryRun) {
    info(`Would delete ${path}`)
    return
  }

  await hubFetch(`/notes/file/${encodeURIComponent(path)}`, { method: 'DELETE' })
  output({ deleted: path }, flags)
}

async function notesRename(args: string[], flags: GlobalFlags): Promise<void> {
  const from = args[0]
  const to = args[1]
  if (!from || !to) exitWithError('USAGE', 'Usage: con notes rename <from> <to>', flags)

  if (flags.dryRun) {
    info(`Would rename ${from} → ${to}`)
    return
  }

  await hubFetch('/notes/rename', { method: 'POST', body: { from, to } })
  output({ renamed: { from, to } }, flags)
}

async function notesMkdir(args: string[], flags: GlobalFlags): Promise<void> {
  const path = args[0]
  if (!path) exitWithError('USAGE', 'Usage: con notes mkdir <path>', flags)

  if (flags.dryRun) {
    info(`Would create directory ${path}`)
    return
  }

  await hubFetch(`/notes/mkdir/${encodeURIComponent(path)}`, { method: 'POST' })
  output({ created: path }, flags)
}

async function notesSearch(args: string[], flags: GlobalFlags): Promise<void> {
  const query = args[0]
  if (!query) exitWithError('USAGE', 'Usage: con notes search <query>', flags)

  const opts = parseFlags(args.slice(1))
  const mode = opts.mode || 'filename'

  // For filename search, filter the file list client-side
  const files = await hubFetch<Array<{ path: string; name: string; dir: string; mtime: string }>>('/notes')

  const q = query.toLowerCase()
  let results: Array<{ path: string; name: string; score: number }>

  if (mode === 'content') {
    // Content search: read each file and search (expensive for large vaults)
    // For now, do filename search as content search requires server-side support
    info('Content search requires server-side search index. Falling back to filename search.')
    results = files
      .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .map((f) => ({ path: f.path, name: f.name, score: f.name.toLowerCase().includes(q) ? 2 : 1 }))
  } else {
    results = files
      .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .map((f) => ({ path: f.path, name: f.name, score: f.name.toLowerCase().startsWith(q) ? 3 : f.name.toLowerCase().includes(q) ? 2 : 1 }))
  }

  results.sort((a, b) => b.score - a.score)
  output(results.map(({ path, name }) => ({ path, name })), flags)
}

async function notesDaily(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const today = new Date()
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const path = `daily/${dateStr}.md`

  if (opts.content) {
    // Append to daily note
    const current = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(path)}`).catch(() => ({ content: `# ${dateStr}\n` }))
    const newContent = (current.content || `# ${dateStr}\n`) + '\n' + opts.content

    if (flags.dryRun) {
      info(`Would append to daily note ${path}`)
      return
    }

    await hubFetch(`/notes/file/${encodeURIComponent(path)}`, { method: 'PUT', body: { content: newContent } })
    output({ path, appended: opts.content.length }, flags)
  } else {
    // Read daily note
    const data = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(path)}`).catch(() => ({ content: '(no daily note for today)' }))
    if (flags.json || flags.agent || !process.stdout.isTTY) {
      output(data, flags)
    } else {
      process.stdout.write(data.content + '\n')
    }
  }
}
