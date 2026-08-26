// Unified Inbox pane — routing rules persistence.
//
// The SPA routes every mail thread / chat room / feed item to either the
// casual "feed" list or the must-handle "inbox" list; the per-source
// overrides live here (inbox-rules.json) so routing follows the user across
// devices. Shape is owned by src/inbox/types.ts (InboxRules) — the hub just
// stores the JSON verbatim.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export class InboxRulesStore {
  private file: string

  constructor(configDir: string) {
    this.file = join(configDir, 'inbox-rules.json')
  }

  get(): unknown {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  set(rules: unknown): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(rules, null, 2))
    renameSync(tmp, this.file)
  }
}

export function handleInboxRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  store: InboxRulesStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/inbox')) return false
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (path === '/inbox/rules' && req.method === 'GET') {
    json(store.get())
    return true
  }

  if (path === '/inbox/rules' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const rules = JSON.parse(body || '{}')
        store.set(rules)
        json({ ok: true })
      } catch {
        json({ error: 'invalid JSON' }, 400)
      }
    })
    return true
  }

  return false
}
