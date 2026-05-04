// con dashboard — surface the same data the Home tab shows from the terminal.

import { readFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function dashboard(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return statusCmd(flags)
    case 'alerts': return alertsCmd(flags)
    case 'servers': return serversCmd(args, flags)
    case 'canvas': return canvasCmd(args, flags)
    default:
      exitWithError('USAGE', `Unknown dashboard command: ${verb ?? ''}. Try: status, alerts, servers, canvas.`, flags)
  }
}

async function statusCmd(flags: GlobalFlags): Promise<void> {
  const snap = await hubFetch<unknown>('/dashboard/snapshot')
  output(snap, flags)
}

async function alertsCmd(flags: GlobalFlags): Promise<void> {
  const r = await hubFetch<{ alerts: unknown[] }>('/dashboard/alerts')
  output(r.alerts, flags)
}

async function serversCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case undefined:
    case 'list': {
      const r = await hubFetch<{ servers: unknown[] }>('/dashboard/servers')
      output(r.servers, flags)
      return
    }
    case 'add': {
      const opts = parseFlags(rest)
      const name = opts.name ?? rest[0]
      const url = opts.url ?? rest[1]
      if (!name || !url) {
        exitWithError('USAGE', 'Usage: con dashboard servers add <name> <url>', flags)
        return
      }
      const expectStatus = opts['expect-status'] ? parseInt(opts['expect-status'], 10) : undefined
      const server = await hubFetch<unknown>('/dashboard/servers', {
        method: 'POST',
        body: { name, url, expectStatus },
      })
      output(server, flags)
      return
    }
    case 'remove': {
      const id = rest[0]
      if (!id) {
        exitWithError('USAGE', 'Usage: con dashboard servers remove <id>', flags)
        return
      }
      const r = await hubFetch<unknown>(`/dashboard/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
      output(r, flags)
      return
    }
    default:
      exitWithError('USAGE', `Unknown dashboard servers verb: ${sub}. Try: list, add, remove.`, flags)
  }
}

async function canvasCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case undefined:
    case 'list': {
      const r = await hubFetch<{ islands: unknown[] }>('/dashboard/canvas/islands')
      output(r.islands, flags)
      return
    }
    case 'add': {
      const opts = parseFlags(rest)
      const slug = opts.slug ?? rest.find((a) => !a.startsWith('--'))
      if (!slug) {
        exitWithError('USAGE', "Usage: con dashboard canvas add <slug> [--title 'X'] [--by X] [--weight N] [--accent #hex] [--expires-in 30m] (HTML on stdin or --file PATH)", flags)
        return
      }
      const html = opts.file
        ? readFileSync(opts.file, 'utf8')
        : await readStdin()
      if (!html) {
        exitWithError('USAGE', 'No HTML provided. Pipe to stdin or use --file PATH.', flags)
        return
      }
      const meta: Record<string, unknown> = {}
      if (opts.title) meta.title = opts.title
      // Note: `--agent` is a global flag (forces JSON mode), so use `--by`.
      if (opts.by) meta.agent = opts.by
      if (opts.accent) meta.accent = opts.accent
      if (opts.weight) meta.weight = parseInt(opts.weight, 10)
      const ttl = opts['expires-in'] ? parseDuration(opts['expires-in']) : undefined
      if (ttl != null) meta.expiresAt = Date.now() + ttl
      const r = await hubFetch<unknown>('/dashboard/canvas/islands', { method: 'POST', body: { slug, html, meta } })
      output(r, flags)
      return
    }
    case 'remove': {
      const slug = rest[0]
      if (!slug) {
        exitWithError('USAGE', 'Usage: con dashboard canvas remove <slug>', flags)
        return
      }
      const r = await hubFetch<unknown>(`/dashboard/canvas/islands/${encodeURIComponent(slug)}`, { method: 'DELETE' })
      output(r, flags)
      return
    }
    case 'clear': {
      const r = await hubFetch<unknown>('/dashboard/canvas/islands', { method: 'DELETE' })
      output(r, flags)
      return
    }
    case 'reset': {
      // Wipes EVERYTHING (incl. direct index.html writes) back to placeholder.
      const r = await hubFetch<unknown>('/canvas', { method: 'DELETE' })
      output(r, flags)
      return
    }
    default:
      exitWithError('USAGE', `Unknown dashboard canvas verb: ${sub}. Try: list, add, remove, clear, reset.`, flags)
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)\s*(s|m|h|d)$/i)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!
}
