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
//   con spaces board <project> note "<card>" "text"
//   con spaces board <project> edit "<card>" [--text "new"] [--detail "a|b"]
//   con spaces board <project> remove "<card>"
//
// <project> is a slug (board resolved like the Spaces UI: board.md/kanban.md
// by name, else first kanban-flagged file) or a vault-relative .md path.

import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

interface CardView {
  text: string
  column: string
  agentKey: string | null
  blockId: string | null
  blocked: boolean
  checked: boolean
  detail: string[]
}

export async function spaces(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  if (verb !== 'board') {
    exitWithError('USAGE', 'Usage: con spaces board <project> [add|move|assign|model|block|unblock|note|edit|remove] …', flags)
    return
  }
  const project = args[0]
  if (!project) { exitWithError('USAGE', 'Usage: con spaces board <project> …', flags); return }
  const action = args[1]
  const rest = args.slice(2)
  const opts = parseFlags(rest)
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && !rest[i - 1]!.includes('=')))
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
      if (!text) { exitWithError('USAGE', 'Usage: con spaces board <project> add "text" [--to <column>] [--assign <key>] [--detail "a|b"] [--bottom]', flags); return }
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
    case 'nofork':
    case 'forkok': {
      const card = pos[0]
      if (!card) { exitWithError('USAGE', `Usage: con spaces board <project> ${action} "<card>"`, flags); return }
      output(await hubFetch(`/board/${enc}/nofork`, { method: 'POST', body: { card, nofork: action === 'nofork' } }), flags)
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
      if (!card || !note) { exitWithError('USAGE', 'Usage: con spaces board <project> note "<card>" "text"', flags); return }
      output(await hubFetch(`/board/${enc}/note`, { method: 'POST', body: { card, note } }), flags)
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
    default:
      exitWithError('USAGE', `Unknown board action: ${action}. Try: show, add, move, assign, block, unblock, note, edit, remove.`, flags)
  }
}
