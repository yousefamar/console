// Search / read over an open index — the worker dispatches here, tests call it directly.

import type { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { parseAddress } from './address.js'
import { needsIndex, upsertSession, type SessionMeta } from './db.js'
import { parseTranscript } from './parse.js'
import { eventAt, eventsFor, fallbackSearch, orTerms, recent, resolveSession, search, turnByRef, type Filters } from './query.js'
import { renderFallback, renderFiles, renderHits, renderRecent, shortPath, viewEvent, viewSession, viewTurn } from './render.js'

export const SEARCH_DEFAULT_LIMIT = 8
export const LISTING_DEFAULT_LIMIT = 15
export const LISTING_MAX_LIMIT = 40
export const READ_DEFAULT_MAX_CHARS = 8000
const DEFAULT_LISTING_WINDOW = '14d'
const FALLBACK_LIMIT = 5

export interface SearchParams {
  query: string
  filters: Filters
  limit?: number
  cwdHint?: string
  includeTools?: boolean
}

export interface ReadParams {
  address: string
  turns?: string
  grep?: string
  maxChars?: number
  includeTools?: boolean
}

function scope(f: Filters): string {
  let where = 'across all projects'
  if (f.under) where = `under ${shortPath(f.under)}`
  else if (f.project) where = `in "${f.project}"`
  if (f.since) return `${where} since ${f.since}`
  return where
}

export function runSearch(db: DatabaseSync, p: SearchParams): { text: string; hits: number; fallback?: string } {
  const query = p.query.trim()
  const f = { ...p.filters }
  if (!query) {
    const limit = p.limit && p.limit !== SEARCH_DEFAULT_LIMIT ? Math.min(Math.max(p.limit, 1), LISTING_MAX_LIMIT) : LISTING_DEFAULT_LIMIT
    if (!f.since && !f.file && !f.session) f.since = DEFAULT_LISTING_WINDOW
    const rows = recent(db, f, limit)
    if (f.file) return { text: renderFiles(db, rows, f.file), hits: rows.length }
    return { text: renderRecent(rows, scope(f)), hits: rows.length }
  }
  const limit = Math.max(p.limit ?? SEARCH_DEFAULT_LIMIT, 1)
  const hits = search(db, query, f, { limit, cwdHint: p.cwdHint })
  if (hits.length) return { text: renderHits(hits, query, { showTools: !!p.includeTools }), hits: hits.length }
  const terms = orTerms(query)
  const weak = fallbackSearch(db, terms, f, { limit: FALLBACK_LIMIT, cwdHint: p.cwdHint })
  return { text: renderFallback(weak, query, terms), hits: weak.length, fallback: terms.join(' OR ') }
}

export function runRead(db: DatabaseSync, p: ReadParams): { text: string } {
  const addr = parseAddress(p.address)
  const maxChars = Math.max(p.maxChars ?? READ_DEFAULT_MAX_CHARS, 200)
  const s = resolveSession(db, addr.session)
  if (!addr.turn) return { text: viewSession(db, s, p.turns ?? '', p.grep ?? '', maxChars) }
  const t = turnByRef(db, s.id, addr.turn)
  if (addr.seq >= 0) return { text: viewEvent(s, t, eventAt(db, s.id, t.idx, addr.seq), p.grep ?? '', maxChars) }
  const events = p.includeTools ? eventsFor(db, s.id, t.idx) : null
  return { text: viewTurn(db, s, t, events, p.grep ?? '', maxChars) }
}

export interface IndexResult { indexed: boolean; turns: number; ms: number }

/** Parse one transcript and (re)write its rows. Skips unchanged files unless forced. */
export function indexFile(db: DatabaseSync, sessionId: string, path: string, meta: SessionMeta = {}, force = false): IndexResult {
  const t0 = Date.now()
  const st = statSync(path)
  const src = { path, size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  if (!force && !needsIndex(db, sessionId, src)) return { indexed: false, turns: 0, ms: Date.now() - t0 }
  const parsed = parseTranscript(path, sessionId)
  upsertSession(db, parsed, src, meta)
  return { indexed: true, turns: parsed.turns.length, ms: Date.now() - t0 }
}
