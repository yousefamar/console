// Read side of the index: session resolution, listing, FTS search, views.

import type { DatabaseSync } from 'node:sqlite'

export class NotFoundError extends Error {}

export interface Filters {
  /** substring of the session cwd */
  project?: string
  /** cwd prefix (`--here`) */
  under?: string
  /** YYYY-MM-DD, relative (7d, 2w, 3m) or ISO timestamp */
  since?: string
  until?: string
  /** substring of a path the session read or wrote */
  file?: string
  /** substring of the git branch */
  branch?: string
  /** session id (or prefix) to search inside */
  session?: string
  /** the caller's own session, never listed */
  excludeId?: string
}

export interface SessionRow {
  id: string
  cwd: string
  git_branch: string
  title: string
  hub_name: string
  agent_key: string
  started_at: string
  ended_at: string
  entrypoint: string
  turn_count: number
  first_prompt: string
  last_prompt: string
  last_reply: string
}

export interface TurnRow {
  session_id: string
  idx: number
  uuid: string
  ts: string
  user_text: string
  assistant_text: string
  tool_count: number
}

export interface EventRow {
  session_id: string
  turn_idx: number
  seq: number
  name: string
  input_summary: string
  result: string
  truncated: number
}

export interface TurnHit { idx: number; uuid: string; ts: string; score: number; snippet: string }
export interface ToolHit { turnIdx: number; seq: number; name: string; score: number; snippet: string }
export interface SessionHit {
  session: SessionRow
  score: number
  turns: TurnHit[]
  tools: ToolHit[]
  toolMatchCount: number
  files: string[]
}

const RELATIVE = /^(\d+)\s*([dwmy])$/i

export function parseSince(value: string, now = new Date()): string {
  const v = value.trim()
  if (!v) return ''
  const rel = RELATIVE.exec(v)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]!.toLowerCase()
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365
    return new Date(now.getTime() - days * 86_400_000).toISOString()
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`bad date "${value}" (YYYY-MM-DD, 7d/2w/3m, or ISO)`)
  return d.toISOString()
}

function parseUntil(value: string, now = new Date()): string {
  const v = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T23:59:59.999Z`
  return parseSince(v, now)
}

const OPERATORS = new Set(['AND', 'OR', 'NOT'])

/** User words → an FTS5 MATCH expression: every token quoted (so punctuation
 *  can't break the grammar), trailing `*` kept as a prefix query, and
 *  upper-case AND/OR/NOT between tokens passed through as operators. */
export function buildMatch(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (const raw of tokens) {
    if (OPERATORS.has(raw)) { if (out.length && !OPERATORS.has(out[out.length - 1]!)) out.push(raw); continue }
    const prefix = raw.endsWith('*')
    const word = raw.replace(/\*+$/, '').replace(/"/g, '').trim()
    if (!word) continue
    out.push(`"${word}"${prefix ? '*' : ''}`)
  }
  while (out.length && OPERATORS.has(out[out.length - 1]!)) out.pop()
  return out.join(' ')
}

/** Distinctive words for the OR fallback: longer than 3 chars, deduped. */
export function orTerms(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of query.split(/\s+/)) {
    const w = raw.replace(/[^\p{L}\p{N}_-]/gu, '').toLowerCase()
    if (w.length < 4 || OPERATORS.has(raw) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out.slice(0, 8)
}

export function resolveSession(db: DatabaseSync, prefix: string): SessionRow {
  const rows = db.prepare('SELECT * FROM sessions WHERE id LIKE ? ORDER BY ended_at DESC LIMIT 3').all(`${prefix.toLowerCase()}%`) as unknown as SessionRow[]
  if (rows.length === 0) throw new NotFoundError(`no indexed session matches "${prefix}"`)
  if (rows.length > 1 && prefix.length < 36) throw new NotFoundError(`"${prefix}" is ambiguous (${rows.map((r) => r.id.slice(0, 12)).join(', ')}) — give more characters`)
  return rows[0]!
}

interface Where { sql: string; params: Array<string | number> }

function sessionWhere(f: Filters, now: Date, alias = 's'): Where {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (f.project) { clauses.push(`${alias}.cwd LIKE ?`); params.push(`%${f.project}%`) }
  if (f.under) { clauses.push(`(${alias}.cwd = ? OR ${alias}.cwd LIKE ?)`); params.push(f.under, `${f.under.replace(/\/$/, '')}/%`) }
  if (f.since) { clauses.push(`${alias}.ended_at >= ?`); params.push(parseSince(f.since, now)) }
  if (f.until) { clauses.push(`${alias}.started_at <= ?`); params.push(parseUntil(f.until, now)) }
  if (f.branch) { clauses.push(`${alias}.git_branch LIKE ?`); params.push(`%${f.branch}%`) }
  if (f.file) { clauses.push(`EXISTS (SELECT 1 FROM files fl WHERE fl.session_id = ${alias}.id AND fl.path LIKE ?)`); params.push(`%${f.file}%`) }
  if (f.session) { clauses.push(`${alias}.id LIKE ?`); params.push(`${f.session.toLowerCase()}%`) }
  if (f.excludeId) { clauses.push(`${alias}.id <> ?`); params.push(f.excludeId) }
  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', params }
}

export function recent(db: DatabaseSync, f: Filters, limit: number, now = new Date()): SessionRow[] {
  const w = sessionWhere(f, now)
  return db.prepare(`SELECT s.* FROM sessions s WHERE ${w.sql} ORDER BY s.ended_at DESC LIMIT ?`).all(...w.params, limit) as unknown as SessionRow[]
}

export function sessionFiles(db: DatabaseSync, sessionId: string, action?: 'read' | 'write'): Array<{ path: string; action: string; n: number }> {
  const sql = action
    ? 'SELECT path, action, n FROM files WHERE session_id = ? AND action = ? ORDER BY n DESC, path'
    : 'SELECT path, action, n FROM files WHERE session_id = ? ORDER BY action DESC, n DESC, path'
  return (action ? db.prepare(sql).all(sessionId, action) : db.prepare(sql).all(sessionId)) as Array<{ path: string; action: string; n: number }>
}

const RAW_LIMIT = 600
const SNIPPET_TOKENS = 14

interface SearchOpts {
  limit: number
  cwdHint?: string
  perSession?: number
  now?: Date
}

/** Full-text search. Turn matches rank the session (best bm25, boosted under
 *  the caller's cwd); tool-output matches are counted and returned separately. */
export function search(db: DatabaseSync, query: string, f: Filters, opts: SearchOpts): SessionHit[] {
  const match = buildMatch(query)
  if (!match) return []
  return runMatch(db, match, f, opts)
}

export function fallbackSearch(db: DatabaseSync, terms: string[], f: Filters, opts: SearchOpts): SessionHit[] {
  if (terms.length < 2) return []
  const match = terms.map((t) => `"${t}"`).join(' OR ')
  return runMatch(db, match, f, opts)
}

function runMatch(db: DatabaseSync, match: string, f: Filters, opts: SearchOpts): SessionHit[] {
  const now = opts.now ?? new Date()
  const w = sessionWhere(f, now)
  const perSession = opts.perSession ?? (f.session ? 12 : 2)
  const turnRows = db.prepare(`
    SELECT t.session_id, t.idx, t.uuid, t.ts, bm25(turns_fts, 1.5, 1.0) AS score,
           snippet(turns_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS s_user,
           snippet(turns_fts, 1, '[', ']', '…', ${SNIPPET_TOKENS}) AS s_asst
    FROM turns_fts JOIN turns t ON t.rowid = turns_fts.rowid JOIN sessions s ON s.id = t.session_id
    WHERE turns_fts MATCH ? AND ${w.sql}
    ORDER BY score LIMIT ?`).all(match, ...w.params, RAW_LIMIT) as Array<{ session_id: string; idx: number; uuid: string; ts: string; score: number; s_user: string; s_asst: string }>
  const toolRows = db.prepare(`
    SELECT e.session_id, e.turn_idx, e.seq, e.name, bm25(tools_fts, 2.0, 1.0) AS score,
           snippet(tools_fts, 1, '[', ']', '…', ${SNIPPET_TOKENS}) AS s_res,
           snippet(tools_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS s_in
    FROM tools_fts JOIN tool_events e ON e.rowid = tools_fts.rowid JOIN sessions s ON s.id = e.session_id
    WHERE tools_fts MATCH ? AND ${w.sql}
    ORDER BY score LIMIT ?`).all(match, ...w.params, RAW_LIMIT) as Array<{ session_id: string; turn_idx: number; seq: number; name: string; score: number; s_res: string; s_in: string }>

  const bySession = new Map<string, SessionHit>()
  const ensure = (id: string): SessionHit => {
    let hit = bySession.get(id)
    if (!hit) {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow
      hit = { session, score: 0, turns: [], tools: [], toolMatchCount: 0, files: [] }
      bySession.set(id, hit)
    }
    return hit
  }
  for (const r of turnRows) {
    const hit = ensure(r.session_id)
    if (hit.turns.length >= perSession) continue
    const snippet = pickSnippet(r.s_user, r.s_asst)
    hit.turns.push({ idx: r.idx, uuid: r.uuid, ts: r.ts, score: r.score, snippet })
  }
  for (const r of toolRows) {
    const hit = ensure(r.session_id)
    hit.toolMatchCount++
    if (hit.tools.length >= perSession) continue
    hit.tools.push({ turnIdx: r.turn_idx, seq: r.seq, name: r.name, score: r.score, snippet: pickSnippet(r.s_res, r.s_in) })
  }
  const hits = [...bySession.values()]
  for (const hit of hits) {
    // Turn matches rank; tool-only matches rank after every turn match.
    const best = hit.turns.length ? Math.min(...hit.turns.map((t) => t.score)) : Math.min(...hit.tools.map((t) => t.score)) * 0.3
    const under = opts.cwdHint && (hit.session.cwd === opts.cwdHint || hit.session.cwd.startsWith(opts.cwdHint.replace(/\/$/, '') + '/'))
    hit.score = best * (under ? 1.25 : 1)
    hit.files = sessionFiles(db, hit.session.id, 'write').slice(0, 6).map((r) => r.path)
  }
  hits.sort((a, b) => a.score - b.score || (b.session.ended_at < a.session.ended_at ? -1 : 1))
  return hits.slice(0, opts.limit)
}

function pickSnippet(a: string, b: string): string {
  const ha = a.includes('[') ? a : ''
  const hb = b.includes('[') ? b : ''
  return (ha || hb || a || b).replace(/\s+/g, ' ').trim()
}

export function turnsOf(db: DatabaseSync, sessionId: string): TurnRow[] {
  return db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY idx').all(sessionId) as unknown as TurnRow[]
}

export function turnByRef(db: DatabaseSync, sessionId: string, ref: string): TurnRow {
  const m = /^t(\d+)$/i.exec(ref)
  const row = (m
    ? db.prepare('SELECT * FROM turns WHERE session_id = ? AND idx = ?').get(sessionId, Number(m[1]))
    : db.prepare('SELECT * FROM turns WHERE session_id = ? AND uuid LIKE ? ORDER BY idx LIMIT 1').get(sessionId, `${ref.toLowerCase()}%`)) as TurnRow | undefined
  if (!row) throw new NotFoundError(`no turn "${ref}" in session ${sessionId.slice(0, 8)}`)
  return row
}

export function eventsFor(db: DatabaseSync, sessionId: string, turnIdx: number): EventRow[] {
  return db.prepare('SELECT * FROM tool_events WHERE session_id = ? AND turn_idx = ? ORDER BY seq').all(sessionId, turnIdx) as unknown as EventRow[]
}

export function eventAt(db: DatabaseSync, sessionId: string, turnIdx: number, seq: number): EventRow {
  const row = db.prepare('SELECT * FROM tool_events WHERE session_id = ? AND turn_idx = ? AND seq = ?').get(sessionId, turnIdx, seq) as EventRow | undefined
  if (!row) throw new NotFoundError(`no tool call #${seq} in turn t${turnIdx} of ${sessionId.slice(0, 8)}`)
  return row
}

/** Select turns: "last:5", "first:3", "2-6", "1,4,9" (indices), '' = all. */
export function selectTurns(all: TurnRow[], spec: string): TurnRow[] {
  const s = spec.trim()
  if (!s) return all
  let m = /^last:(\d+)$/i.exec(s)
  if (m) return all.slice(-Number(m[1]))
  m = /^first:(\d+)$/i.exec(s)
  if (m) return all.slice(0, Number(m[1]))
  m = /^(\d+)-(\d+)$/.exec(s)
  if (m) { const a = Number(m[1]), b = Number(m[2]); return all.filter((t) => t.idx >= a && t.idx <= b) }
  if (/^\d+(,\d+)*$/.test(s)) { const want = new Set(s.split(',').map(Number)); return all.filter((t) => want.has(t.idx)) }
  throw new Error(`bad turns spec "${spec}" (last:N, first:N, A-B, or 1,4,9)`)
}
