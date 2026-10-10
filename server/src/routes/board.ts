// Board mutation routes — the HTTP surface over kanban/board-ops.ts.
// One short call per mutation; the hub is the single writer (per-board
// lock in BoardOps), so concurrent agents serialize instead of clobbering.
//
//   GET  /board/:project                    → columns + cards
//   POST /board/:project/cards              {text, createdBy?, meta?, column?, assign?, detail?, bottom?}   a creator is REQUIRED: createdBy, else the X-Console-Agent header, else the app's User-Agent
//   POST /board/:project/tag                {card, key, value|null}   set/clear one #key/value metadata tag
//   POST /board/:project/move               {card, to}         card = "^id" | text (unique substring); an id always wins
//   POST /board/:project/assign             {card, agent|null}
//   POST /board/:project/block              {card, blocked, note?}
//   POST /board/:project/note               {card, note}       multi-line OK — one detail line per line
//   POST /board/:project/unnote             {card, count?}     take a note back: count lines, else the last recorded note's
//   POST /board/:project/attach             {card, image: base64, ext?, caption?}   screenshot/clip (png/jpg/gif/webp/webm/mp4, ≤20 MB) → asset + media detail line
//   POST /board/:project/owner              {agent|null}       board frontmatter default_owner
//   POST /board/:project/model              {card, model|null}   pin the ticket-fork's model
//   POST /board/:project/edit               {card, text?, detail?}
//   POST /board/:project/remove             {card}
//   POST /board/:project/redispatch         {card}   re-wake/re-fork a stamped card
//   GET  /board/:project/history            → pre-write journal copies, newest first
//   POST /board/:project/restore            {ts, confirm: true}   HUMAN-ONLY: overwrite the board with a journal copy

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BoardOps } from '../kanban/board-ops.js'
import { EFFORTS, isEffort } from '../agents/effort.js'

export interface BoardRedispatch {
  /** Resolve the card and re-fire dispatch for it (BoardWatcher.redispatch).
   *  boardPath is vault-relative. */
  (boardPath: string, blockId: string): Promise<{ ok: boolean; error?: string }>
}

/** Who is creating this card: what the caller says, else the agent the CLI
 *  names in its header, else the client the request plainly comes from (an
 *  app or CLI build from before it sent `createdBy` itself). No answer = no card. */
export function cardCreator(body: Record<string, unknown>, actor: string | undefined, userAgent: string | undefined): string {
  if (typeof body.createdBy === 'string' && body.createdBy.trim()) return body.createdBy.trim()
  if (actor) return actor
  if (/^okhttp\//i.test(userAgent ?? '')) return 'android'
  if (/^Mozilla\//.test(userAgent ?? '')) return 'ui'
  // A `con` from before it sent createdBy, run by a script with no agent key.
  if (/^(node|undici)\b/i.test(userAgent ?? '')) return 'cli'
  throw new Error('a card needs a creator: send {createdBy: "<who>"} (CLI: --by <your name>)')
}

/** `{meta: {"requested-by": "essam"}}` off a request body — strings only. */
function metaOf(body: Record<string, unknown>): Record<string, string> | undefined {
  if (body.meta === undefined || body.meta === null) return undefined
  if (typeof body.meta !== 'object' || Array.isArray(body.meta)) throw new Error('meta must be an object of key → value strings')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(body.meta as Record<string, unknown>)) {
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`meta.${k} must be a string`)
    out[k] = String(v)
  }
  return out
}

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
  redispatch?: BoardRedispatch,
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
  if (verb === 'history' && req.method === 'GET') {
    ops.history(project)
      .then((r) => json(res, 200, r))
      .catch((e) => json(res, 404, { error: (e as Error).message }))
    return true
  }

  if (req.method !== 'POST') return false

  switch (verb) {
    case 'cards':
      run((b) => ops.add(project, String(b.text ?? ''), {
        createdBy: cardCreator(b, actor, req.headers['user-agent']),
        meta: metaOf(b),
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
    case 'effort':
      run((b) => {
        const effort = typeof b.effort === 'string' && b.effort.trim() ? b.effort.trim() : null
        if (effort !== null && !isEffort(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')} (or none)`)
        return ops.setEffort(project, String(b.card ?? ''), effort, actor)
      })
      return true
    case 'forge':
    case 'local':
      // `remote: null` clears the tag and defers to the board's frontmatter.
      run((b) => ops.setRemote(project, String(b.card ?? ''), b.remote === null ? null : (verb as 'forge' | 'local'), actor))
      return true
    case 'tag':
      run((b) => {
        if (typeof b.key !== 'string' || !b.key.trim()) throw new Error('tag needs {key}')
        const value = b.value === null || b.value === undefined || b.value === '' ? null : String(b.value)
        return ops.setMeta(project, String(b.card ?? ''), b.key, value, actor)
      })
      return true
    case 'nofork':
      run((b) => ops.setNofork(project, String(b.card ?? ''), b.nofork !== false, actor))
      return true
    case 'inherit':
      run((b) => ops.setInherit(project, String(b.card ?? ''), b.inherit !== false, actor))
      return true
    case 'note':
      run((b) => ops.note(project, String(b.card ?? ''), String(b.note ?? ''), actor))
      return true
    case 'unnote':
      run((b) => {
        const count = b.count === undefined || b.count === null ? undefined : Number(b.count)
        if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw new Error('count must be a positive whole number of trailing detail lines')
        return ops.unnote(project, String(b.card ?? ''), { count }, actor)
      })
      return true
    case 'attach':
      run((b) => {
        const image = typeof b.image === 'string' ? Buffer.from(b.image, 'base64') : null
        if (!image?.length) throw new Error('attach needs {image: <base64>}')
        return ops.attach(project, String(b.card ?? ''), {
          data: image,
          ext: typeof b.ext === 'string' ? b.ext : 'png',
          caption: typeof b.caption === 'string' ? b.caption : undefined,
        }, actor)
      })
      return true
    case 'owner':
      run((b) => ops.setDefaultOwner(project, typeof b.agent === 'string' && b.agent.trim() ? b.agent.trim() : null))
      return true
    case 'edit':
      run((b) => ops.edit(project, String(b.card ?? ''), { text: b.text as string | undefined, detail: b.detail as string[] | undefined }))
      return true
    case 'remove':
      run((b) => ops.remove(project, String(b.card ?? '')))
      return true
    case 'restore':
      run(async (b) => {
        const ts = Number(b.ts)
        if (!Number.isFinite(ts) || ts <= 0) throw new Error('restore needs {ts: <journal epoch ms>} — see history')
        if (b.confirm !== true) throw new Error('restore overwrites the live board — HUMAN-ONLY; pass {confirm: true} (CLI: --confirm)')
        return ops.restore(project, ts)
      })
      return true
    case 'redispatch':
      if (!redispatch) return false
      run(async (b) => {
        const hit = await ops.resolveCard(project, String(b.card ?? ''))
        if (!hit.blockId) throw new Error(`card "${b.card}" has no ^id stamp — it was never dispatched (assign it and move it to In Progress instead)`)
        const r = await redispatch(hit.path, hit.blockId)
        if (!r.ok) throw new Error(r.error ?? 'redispatch failed')
        return { redispatched: hit.blockId, path: hit.path }
      })
      return true
  }
  return false
}
