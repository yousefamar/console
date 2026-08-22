// Board mutation routes — the HTTP surface over kanban/board-ops.ts.
// One short call per mutation; the hub is the single writer (per-board
// lock in BoardOps), so concurrent agents serialize instead of clobbering.
//
//   GET  /board/:project                    → columns + cards
//   POST /board/:project/cards              {text, column?, assign?, detail?, bottom?}
//   POST /board/:project/move               {card, to}         card = "^id" | text (unique substring)
//   POST /board/:project/assign             {card, agent|null}
//   POST /board/:project/block              {card, blocked, note?}
//   POST /board/:project/note               {card, note}
//   POST /board/:project/model              {card, model|null}   pin the ticket-fork's model
//   POST /board/:project/edit               {card, text?, detail?}
//   POST /board/:project/remove             {card}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BoardOps } from '../kanban/board-ops.js'

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function handleBoardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ops: BoardOps,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const m = path.match(/^\/board\/([^/]+)(?:\/([a-z]+))?$/)
  if (!m) return false
  const project = decodeURIComponent(m[1]!)
  const verb = m[2]
  // Acting agent (X-Console-Agent, set by the CLI from CONSOLE_AGENT_KEY) —
  // recorded per card so notifiers can skip echoing an agent's own edits.
  const actor = (req.headers['x-console-agent'] as string | undefined)?.trim() || undefined

  const run = (fn: (b: Record<string, unknown>) => Promise<unknown>) => {
    readBody(req).then(async (raw) => {
      try {
        json(res, 200, await fn(raw ? JSON.parse(raw) as Record<string, unknown> : {}))
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
      }
    }).catch((e) => json(res, 500, { error: (e as Error).message }))
  }

  if (!verb && req.method === 'GET') {
    ops.show(project)
      .then((r) => json(res, 200, r))
      .catch((e) => json(res, 404, { error: (e as Error).message }))
    return true
  }

  if (req.method !== 'POST') return false

  switch (verb) {
    case 'cards':
      run((b) => ops.add(project, String(b.text ?? ''), {
        column: b.column as string | undefined,
        agentKey: b.assign as string | undefined,
        detail: b.detail as string[] | undefined,
        top: b.bottom ? false : true,
      }))
      return true
    case 'move':
      run((b) => ops.move(project, String(b.card ?? ''), String(b.to ?? ''), actor))
      return true
    case 'assign':
      run((b) => ops.assign(project, String(b.card ?? ''), (b.agent as string | null) ?? null, actor))
      return true
    case 'block':
      run((b) => ops.setBlocked(project, String(b.card ?? ''), b.blocked !== false, b.note as string | undefined, actor))
      return true
    case 'model':
      run((b) => ops.setModel(project, String(b.card ?? ''), typeof b.model === 'string' && b.model.trim() ? b.model.trim() : null, actor))
      return true
    case 'nofork':
      run((b) => ops.setNofork(project, String(b.card ?? ''), b.nofork !== false, actor))
      return true
    case 'note':
      run((b) => ops.note(project, String(b.card ?? ''), String(b.note ?? ''), actor))
      return true
    case 'edit':
      run((b) => ops.edit(project, String(b.card ?? ''), { text: b.text as string | undefined, detail: b.detail as string[] | undefined }))
      return true
    case 'remove':
      run((b) => ops.remove(project, String(b.card ?? '')))
      return true
  }
  return false
}
