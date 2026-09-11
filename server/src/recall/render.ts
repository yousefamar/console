// Plain-text views for the CLI. Every level prints the address of the next,
// cheaper-to-read level; turn and tool views print a copyable cite line.

import type { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { eventsFor, selectTurns, sessionFiles, turnsOf, type EventRow, type SessionHit, type SessionRow, type TurnRow } from './query.js'

const HOME = homedir()

export function shortPath(p: string): string {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p
}

export function day(ts: string): string {
  return ts ? ts.slice(0, 10) : '????-??-??'
}

function clock(ts: string): string {
  return ts ? ts.slice(11, 16) : ''
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function s8(id: string): string { return id.slice(0, 8) }

export function sessionLabel(s: SessionRow): string {
  return s.hub_name || s.title || ''
}

function headerLine(s: SessionRow): string {
  const parts = [s8(s.id), day(s.ended_at), shortPath(s.cwd)]
  if (s.git_branch) parts.push(`(${s.git_branch})`)
  parts.push(`${s.turn_count}t`)
  const label = sessionLabel(s)
  if (label) parts.push(`"${label}"`)
  return parts.join(' ')
}

function topic(s: SessionRow): string {
  return clip(s.first_prompt || s.title, 160)
}

/** Long sessions drift: show where they ended up, not only where they began. */
function latest(s: SessionRow): string {
  if (s.turn_count < 10 || !s.last_prompt || s.last_prompt === s.first_prompt) return ''
  return clip(s.last_prompt, 160)
}

export function renderRecent(rows: SessionRow[], scope: string): string {
  if (!rows.length) return `No indexed sessions ${scope}.`
  const out = [`${rows.length} most recent sessions ${scope} (newest first). Next: con agent read <session8>`]
  for (const s of rows) {
    out.push(headerLine(s))
    const t = topic(s)
    if (t) out.push(`  ${t}`)
    const l = latest(s)
    if (l) out.push(`  latest: ${l}`)
  }
  return out.join('\n')
}

export function renderFiles(db: DatabaseSync, rows: SessionRow[], file: string): string {
  if (!rows.length) return `No indexed session read or wrote a path matching "${file}".`
  const out = [`${rows.length} sessions touching "${file}" (newest first)`]
  for (const s of rows) {
    out.push(headerLine(s))
    const matching = sessionFiles(db, s.id).filter((f) => f.path.includes(file)).slice(0, 4)
    out.push(`  ${matching.map((f) => `${f.action} ${shortPath(f.path)}×${f.n}`).join(', ')}`)
  }
  return out.join('\n')
}

export function renderHits(hits: SessionHit[], query: string, opts: { showTools: boolean }): string {
  if (!hits.length) return `No indexed session matches "${query}".`
  const out = [`${hits.length} session${hits.length === 1 ? '' : 's'} match "${query}" (best first; among equals prefer the newest). Next: con agent read <session8> --grep "<words>"`]
  for (const h of hits) {
    const s = h.session
    out.push('')
    out.push(headerLine(s))
    const t = topic(s)
    if (t) out.push(`  ${t}`)
    const l = latest(s)
    if (l) out.push(`  latest: ${l}`)
    if (h.files.length) out.push(`  wrote: ${h.files.slice(0, 4).map(shortPath).join(', ')}${h.files.length > 4 ? ` (+${h.files.length - 4})` : ''}`)
    for (const th of h.turns) out.push(`  t${th.idx} ${s8(th.uuid)}: ${clip(th.snippet, 220)}`)
    if (h.toolMatchCount && !opts.showTools) out.push(`  +${h.toolMatchCount} match${h.toolMatchCount === 1 ? '' : 'es'} in tool output (--tools to show)`)
    if (opts.showTools) for (const tl of h.tools) out.push(`  t${tl.turnIdx}#${tl.seq} ${tl.name}: ${clip(tl.snippet, 220)}`)
  }
  out.push('')
  out.push('Snippets are FTS excerpts — never quote them; quote from a turn or tool read.')
  return out.join('\n')
}

export function renderFallback(hits: SessionHit[], query: string, terms: string[]): string {
  if (!hits.length) return `No indexed session matches "${query}" (nor any of: ${terms.join(', ')}).`
  const out = [`No session matches all of "${query}". ${hits.length} match some of: ${terms.join(', ')}`]
  for (const h of hits) {
    out.push(headerLine(h.session))
    const th = h.turns[0]
    if (th) out.push(`  t${th.idx} ${s8(th.uuid)}: ${clip(th.snippet, 200)}`)
  }
  return out.join('\n')
}

function sessionHeader(db: DatabaseSync, s: SessionRow): string[] {
  const out = [headerLine(s)]
  out.push(`started ${s.started_at.replace('T', ' ').slice(0, 16)}  last ${s.ended_at.replace('T', ' ').slice(0, 16)}  cwd ${shortPath(s.cwd)}${s.agent_key ? `  agentKey ${s.agent_key}` : ''}`)
  const writes = sessionFiles(db, s.id, 'write')
  if (writes.length) out.push(`wrote: ${writes.slice(0, 6).map((f) => shortPath(f.path)).join(', ')}${writes.length > 6 ? ` (+${writes.length - 6}; con agent search --file <name> to find them)` : ''}`)
  out.push(`resume: cd ${shortPath(s.cwd)} && claude --resume ${s.id}`)
  return out
}

export function viewSession(db: DatabaseSync, s: SessionRow, turnsSpec: string, grep: string, maxChars: number): string {
  const all = turnsOf(db, s.id)
  if (grep) return grepSession(db, s, all, grep, maxChars)
  const chosen = selectTurns(all, turnsSpec)
  const out = sessionHeader(db, s)
  out.push(`${chosen.length}/${all.length} turns${turnsSpec ? ` (${turnsSpec})` : ''}. Clipped view — never quote from it; read a turn: con agent read ${s8(s.id)}/<uuid8>`)
  const budget = Math.max(200, Math.floor(maxChars / Math.max(chosen.length, 1)))
  const userShare = Math.max(80, Math.floor(budget * 0.45))
  const asstShare = Math.max(80, budget - userShare)
  for (const t of chosen) {
    out.push('')
    out.push(`t${t.idx} ${s8(t.uuid)} ${day(t.ts)} ${clock(t.ts)}${t.tool_count ? `  ${t.tool_count} tool call${t.tool_count === 1 ? '' : 's'}` : ''}`)
    out.push(`  user: ${clip(t.user_text, userShare)}`)
    if (t.assistant_text) out.push(`  claude: ${clip(t.assistant_text, asstShare)}`)
  }
  return out.join('\n')
}

function grepSession(db: DatabaseSync, s: SessionRow, all: TurnRow[], grep: string, maxChars: number): string {
  const re = compileGrep(grep)
  const out = sessionHeader(db, s)
  out.push(`lines matching /${grep}/i as "t<idx> <uuid8> <date> <role>: <line>". Next: con agent read ${s8(s.id)}/<uuid8> [--grep] for the full turn`)
  let total = 0
  let shown = 0
  let used = 0
  const push = (line: string) => {
    total++
    if (used + line.length > maxChars) return
    out.push(line)
    used += line.length + 1
    shown++
  }
  for (const t of all) {
    for (const line of t.user_text.split('\n')) if (re.test(line)) push(`t${t.idx} ${s8(t.uuid)} ${day(t.ts)} user: ${clip(line, 300)}`)
    for (const line of t.assistant_text.split('\n')) if (re.test(line)) push(`t${t.idx} ${s8(t.uuid)} ${day(t.ts)} claude: ${clip(line, 300)}`)
    if (t.tool_count) {
      for (const e of eventsFor(db, s.id, t.idx)) {
        for (const line of e.result.split('\n')) if (re.test(line)) push(`t${t.idx} ${s8(t.uuid)} ${day(t.ts)} tool:${e.name}#${e.seq}: ${clip(line, 300)}`)
      }
    }
  }
  if (total === 0) out.push('(no matching lines)')
  else if (shown < total) out.push(`… ${total - shown} more matching line${total - shown === 1 ? '' : 's'} cut at ${maxChars} chars (raise --max or narrow the pattern)`)
  return out.join('\n')
}

export function compileGrep(pattern: string): RegExp {
  try { return new RegExp(pattern, 'i') } catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
}

function grepLines(text: string, re: RegExp, context = 2): string[] {
  const lines = text.split('\n')
  const keep = new Set<number>()
  lines.forEach((l, i) => { if (re.test(l)) for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j) })
  const out: string[] = []
  let last = -2
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1 && out.length) out.push('  --')
    out.push(lines[i]!)
    last = i
  }
  return out
}

function fit(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + `\n[clipped at ${maxChars} chars — raise --max]` : text
}

export function viewTurn(db: DatabaseSync, s: SessionRow, t: TurnRow, events: EventRow[] | null, grep: string, maxChars: number): string {
  const cite = `[${s8(s.id)} ${s8(t.uuid)} t${t.idx} ${day(t.ts)}]`
  const out = [`${headerLine(s)}  turn t${t.idx} ${s8(t.uuid)} ${t.ts.replace('T', ' ').slice(0, 16)}`]
  out.push(`cite: ${cite}  (append the role: user | claude | tool:<Name>#<seq>)`)
  const re = grep ? compileGrep(grep) : null
  const section = (label: string, body: string) => {
    if (!body) return
    out.push('')
    out.push(`--- ${label}`)
    out.push(re ? (grepLines(body, re).join('\n') || '(no matching lines)') : body)
  }
  section('user', t.user_text)
  section('claude', t.assistant_text)
  const evs = events ?? (t.tool_count ? eventsFor(db, s.id, t.idx) : [])
  if (evs.length) {
    out.push('')
    out.push(`--- tools (${evs.length}; read one: con agent read ${s8(s.id)}/${s8(t.uuid)}#<seq>)`)
    for (const e of evs) {
      const line = `#${e.seq} ${e.name} ${clip(e.input_summary, 160)}`
      if (events) {
        out.push(line)
        const body = re ? grepLines(e.result, re).join('\n') : clip(e.result, 600)
        if (body) out.push(body.split('\n').map((l) => `    ${l}`).join('\n'))
      } else {
        out.push(line)
      }
    }
  }
  return fit(out.join('\n'), maxChars)
}

export function viewEvent(s: SessionRow, t: TurnRow, e: EventRow, grep: string, maxChars: number): string {
  const out = [`${headerLine(s)}  turn t${t.idx} ${s8(t.uuid)}  tool #${e.seq} ${e.name}`]
  out.push(`cite: [${s8(s.id)} ${s8(t.uuid)} t${t.idx}#${e.seq} tool:${e.name} ${day(t.ts)}]`)
  out.push(`input: ${e.input_summary}`)
  out.push('')
  const body = grep ? grepLines(e.result, compileGrep(grep)).join('\n') || '(no matching lines)' : e.result || '(no recorded output)'
  out.push(body)
  if (e.truncated) out.push('[output was capped when indexed]')
  return fit(out.join('\n'), maxChars)
}
