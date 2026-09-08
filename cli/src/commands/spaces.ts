// con spaces — the Spaces tab (project-first UI). `board` = SOFTWARE
// mutation of a project's kanban board via the hub's /board/* routes: one
// short command instead of hand-editing markdown (error-prone, and the LLM
// doing it burns tokens on mechanical line-shuffling). The hub is the single
// writer with a per-board lock, so concurrent agents serialize cleanly.
//
//   con spaces board <project>                                # show
//   con spaces board <project> add "text" [--to Backlog] [--assign key] [--detail "a|b"] [--bottom]
//   con spaces board <project> move "<card>" <column>         # card = ^id or unique text
//   con spaces board <project> assign "<card>" <agentKey|none>
//   con spaces board <project> block "<card>" [--note "why"] / unblock "<card>"
//   con spaces board <project> note "<card>" "text"           # multi-line OK: one detail line per line
//   con spaces board <project> attach "<card>" <image.png> [--caption "what it shows"]
//   con spaces board <project> edit "<card>" [--text "new"] [--detail "a|b"]
//   con spaces board <project> remove "<card>"
//
// <project> is a slug (board resolved like the Spaces UI: board.md/kanban.md
// by name, else first kanban-flagged file) or a vault-relative .md path.

import { readFile } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags, unknownFlags } from './util.js'

interface CardView {
  text: string
  column: string
  agentKey: string | null
  blockId: string | null
  blocked: boolean
  checked: boolean
  detail: string[]
}

/** Flags each board verb accepts. `column` is an alias of `to` on add — it is
 *  the hub body's field name and the one people reach for. */
const BOARD_FLAGS: Record<string, readonly string[]> = {
  show: [], add: ['to', 'column', 'assign', 'detail', 'bottom'], move: [], assign: [], owner: [], model: [],
  nofork: [], forkok: [], inherit: [], fresh: [], block: ['note'], unblock: ['note'], note: [], attach: ['caption'],
  edit: ['text', 'detail'], remove: [], redispatch: [], history: [], restore: ['confirm'],
}

export async function spaces(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  if (verb !== 'board') {
    exitWithError('USAGE', 'Usage: con spaces board <project> [show|add|move|assign|owner|model|nofork|forkok|inherit|fresh|block|unblock|note|attach|edit|remove] … — see `con help spaces` (alias: `con board`)', flags)
    return
  }
  const project = args[0]
  if (!project) { exitWithError('USAGE', 'Usage: con spaces board <project> …', flags); return }
  const action = args[1]
  const rest = args.slice(2)
  const opts = parseFlags(rest)
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && !rest[i - 1]!.includes('=')))
  // A flag the verb doesn't take is a USAGE error, never a silent no-op: an
  // `add --column "In Progress"` used to land in Backlog and "succeed" (^odd-duck).
  const known = BOARD_FLAGS[action ?? 'show'] ?? []
  const stray = unknownFlags(opts, known)
  if (stray.length) {
    exitWithError('USAGE', `${action ?? 'show'} does not take --${stray.join(', --')}${known.length ? ` (known: --${known.join(', --')})` : ' (takes no flags)'} — see \`con help spaces\``, flags)
    return
  }
  if (action === 'add' && opts.column && !opts.to) opts.to = opts.column
  const enc = encodeURIComponent(project)
  const detail = (v: string | undefined) => v ? v.split('|').map((s) => s.trim()).filter(Boolean) : undefined

  switch (action) {
    case undefined:
    case 'show': {
      const r = await hubFetch<{ path: string; columns: Array<{ title: string; cards: CardView[] }> }>(`/board/${enc}`)
      if (flags.json) { output(r, flags); return }
      console.log(r.path)
      for (const col of r.columns) {
        console.log(`\n## ${col.title} (${col.cards.length})`)
        for (const c of col.cards) {
          const bits = [c.checked ? '[x]' : '[ ]', c.text]
          if (c.blocked) bits.push('#blocked')
          if (c.agentKey) bits.push(`@${c.agentKey}`)
          if (c.blockId) bits.push(`^${c.blockId}`)
          console.log(`  ${bits.join(' ')}`)
        }
      }
      return
    }
    case 'add': {
      const text = pos[0]
      if (!text) { exitWithError('USAGE', 'Usage: con spaces board <project> add "text" [--to|--column <column>] [--assign <key>] [--detail "a|b"] [--bottom]', flags); return }
      output(await hubFetch(`/board/${enc}/cards`, { method: 'POST', body: {
        text, column: opts.to, assign: opts.assign, detail: detail(opts.detail), ...(opts.bottom === 'true' ? { bottom: true } : {}),
      } }), flags)
      return
    }
    case 'move': {
      const [card, to] = [pos[0], pos[1]]
      if (!card || !to) { exitWithError('USAGE', 'Usage: con spaces board <project> move "<card>" <column>', flags); return }
      output(await hubFetch(`/board/${enc}/move`, { method: 'POST', body: { card, to } }), flags)
      return
    }
    case 'assign': {
      const [card, agent] = [pos[0], pos[1]]
      if (!card || !agent) { exitWithError('USAGE', 'Usage: con spaces board <project> assign "<card>" <agentKey|none>', flags); return }
      output(await hubFetch(`/board/${enc}/assign`, { method: 'POST', body: { card, agent: agent === 'none' ? null : agent } }), flags)
      return
    }
    case 'model': {
      const [card, model] = [pos[0], pos[1]]
      if (!card || !model) { exitWithError('USAGE', 'Usage: con spaces board <project> model "<card>" <model|none>   (alias like haiku/sonnet, or a full id; none clears)', flags); return }
      output(await hubFetch(`/board/${enc}/model`, { method: 'POST', body: { card, model: model === 'none' ? null : model } }), flags)
      return
    }
    case 'owner': {
      const agent = pos[0]
      if (!agent) { exitWithError('USAGE', 'Usage: con spaces board <project> owner <agentKey|none>   (board frontmatter default_owner — unassigned cards dragged into In Progress auto-assign to it)', flags); return }
      output(await hubFetch(`/board/${enc}/owner`, { method: 'POST', body: { agent: agent === 'none' ? null : agent } }), flags)
      return
    }
    case 'nofork':
    case 'forkok': {
      const card = pos[0]
      if (!card) { exitWithError('USAGE', `Usage: con spaces board <project> ${action} "<card>"`, flags); return }
      output(await hubFetch(`/board/${enc}/nofork`, { method: 'POST', body: { card, nofork: action === 'nofork' } }), flags)
      return
    }
    case 'inherit':
    case 'fresh': {
      const card = pos[0]
      if (!card) { exitWithError('USAGE', `Usage: con spaces board <project> ${action} "<card>"`, flags); return }
      output(await hubFetch(`/board/${enc}/inherit`, { method: 'POST', body: { card, inherit: action === 'inherit' } }), flags)
      return
    }
    case 'block':
    case 'unblock': {
      const card = pos[0]
      if (!card) { exitWithError('USAGE', `Usage: con spaces board <project> ${action} "<card>" [--note "why"]`, flags); return }
      output(await hubFetch(`/board/${enc}/block`, { method: 'POST', body: { card, blocked: action === 'block', note: opts.note } }), flags)
      return
    }
    case 'note': {
      const [card, note] = [pos[0], pos[1]]
      if (!card || !note) { exitWithError('USAGE', 'Usage: con spaces board <project> note "<card>" "text"   (newlines split into one detail line each — bulleted summaries welcome)', flags); return }
      output(await hubFetch(`/board/${enc}/note`, { method: 'POST', body: { card, note } }), flags)
      return
    }
    case 'attach': {
      const [card, file] = [pos[0], pos[1]]
      if (!card || !file) { exitWithError('USAGE', 'Usage: con spaces board <project> attach "<card>" <image.png|jpg|gif|webp> [--caption "what it shows"]', flags); return }
      let data: Buffer
      try { data = await readFile(file) } catch (e) { exitWithError('NOT_FOUND', `cannot read ${file}: ${(e as Error).message}`, flags); return }
      const ext = extname(file).slice(1) || 'png'
      const caption = opts.caption ?? basename(file, extname(file))
      output(await hubFetch(`/board/${enc}/attach`, { method: 'POST', body: { card, image: data.toString('base64'), ext, caption } }), flags)
      return
    }
    case 'edit': {
      const card = pos[0]
      if (!card || (!opts.text && !opts.detail)) { exitWithError('USAGE', 'Usage: con spaces board <project> edit "<card>" [--text "new"] [--detail "a|b"]', flags); return }
      output(await hubFetch(`/board/${enc}/edit`, { method: 'POST', body: { card, text: opts.text, detail: detail(opts.detail) } }), flags)
      return
    }
    case 'remove': {
      const card = pos[0]
      if (!card) { exitWithError('USAGE', 'Usage: con spaces board <project> remove "<card>"', flags); return }
      output(await hubFetch(`/board/${enc}/remove`, { method: 'POST', body: { card } }), flags)
      return
    }
    case 'redispatch': {
      const card = pos[0]
      if (!card) { exitWithError('USAGE', 'Usage: con spaces board <project> redispatch "<card>"   (re-wake the assignee, or re-fork if its session is gone)', flags); return }
      output(await hubFetch(`/board/${enc}/redispatch`, { method: 'POST', body: { card } }), flags)
      return
    }
    case 'history': {
      const r = await hubFetch<{ path: string; entries: Array<{ ts: number; bytes: number }> }>(`/board/${enc}/history`)
      if (flags.json) { output(r, flags); return }
      console.log(`${r.path} — ${r.entries.length} journal cop${r.entries.length === 1 ? 'y' : 'ies'} (pre-write, newest first)`)
      for (const e of r.entries) console.log(`  ${e.ts}  ${new Date(e.ts).toISOString()}  ${e.bytes} bytes`)
      if (r.entries.length) console.log(`restore one (HUMAN-ONLY): con spaces board ${project} restore <ts> --confirm`)
      return
    }
    case 'restore': {
      const ts = Number(pos[0])
      if (!Number.isFinite(ts) || ts <= 0) { exitWithError('USAGE', 'Usage: con spaces board <project> restore <ts> --confirm   (ts from `history`; HUMAN-ONLY — overwrites the live board, the current file is journaled first)', flags); return }
      if (!opts.confirm) { exitWithError('USAGE', 'restore overwrites the live board — HUMAN-ONLY. Re-run with --confirm.', flags); return }
      output(await hubFetch(`/board/${enc}/restore`, { method: 'POST', body: { ts, confirm: true } }), flags)
      return
    }
    default:
      exitWithError('USAGE', `Unknown board action: ${action}. Try: show, add, move, assign, owner, model, nofork, forkok, inherit, fresh, block, unblock, note, edit, remove, redispatch, history, restore — see \`con help spaces\`.`, flags)
  }
}
