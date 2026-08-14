// ============================================================================
// Org protocol — the runtime "who you are + how work flows" every agent gets.
//
// `buildBoardProtocol()` is appended to the system prompt of every fresh agent
// spawn (the createSession choke point) and to Al's persona. Work assignment
// is BOARD-DRIVEN: each project has a markdown kanban board in the vault
// (Obsidian Kanban format); assigning a card to an agent (`@agentkey` on the
// line, card under `## In Progress`) is the delegation, and the agent editing
// its line into `## Done` is the report. Plain text, human- and agent-editable
// — no RPC, no parallel task store.
// ============================================================================

import type { OrgNode } from './registry.js'

/** The standing protocol stanza — kept tight (token cost is paid per spawn). */
export function buildBoardProtocol(): string {
  return [
    '# Work boards (kanban)',
    '',
    'Work is tracked on per-project markdown kanban boards in the vault (`~/sync/brain/root/projects/<slug>/board.md`, Obsidian Kanban format: `## Column` headings + `- [ ] card` lines).',
    '',
    '- **Being assigned**: a card with `@<yourKey>` under `## In Progress` wakes you with a `[BOARD TASK]` message naming the board file. Do the work, then EDIT THE BOARD: move your line under `## Done` and tick it (`- [x] …`). Blocked? Move it under `## Blocked` with an indented note below the line explaining what you need. Always keep the trailing `^id` token on your line — it is the card\'s identity.',
    '- **Assigning others**: add a card to the relevant project board with `@<theirKey>` and put it under `## In Progress` — the hub dispatches it. Under `## Backlog` it is merely planned (not dispatched) until someone moves it.',
    '- **Planning**: cards without an `@key` are unassigned; boards are as much Yousef\'s as yours. Edit boards with normal file tools; keep the format intact (the file round-trips through Obsidian).',
    '',
    'Rules:',
    '- Keep card text CONCISE — one line; details go on indented continuation lines below it.',
    '- Never delete or rewrite someone else\'s in-flight card. Move your own lines only, or append.',
    '- Results that need prose beyond the card: write them into the project\'s docs/notes and reference from the card\'s indented note.',
    '',
    '## Push-to-talk mic',
    'Yousef has a global hold-to-talk key; whatever he speaks is transcribed and auto-sent to whichever session currently "holds the mic" (default Al). If a spoken request is better handled by another session, pass the mic: `con mic pass <agentKey>`. Grab it for yourself with `con mic pass <yourOwnKey>`; `con mic status` shows the owner; `con mic release` hands it back to Al.',
  ].join('\n')
}

/** A one-line description of a role, derived from the first prose sentence of its
 *  charter (skips markdown headers / the memory placeholder / the caveat block). */
export function shortDescription(charter: string | undefined | null, max = 140): string {
  if (!charter) return ''
  const body = charter.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('_(') || line.startsWith('---')) continue
    const sentence = line.split(/(?<=[.!?])\s/)[0]!.replace(/\*\*/g, '')
    return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + '…' : sentence
  }
  return ''
}

/** The whole org as an indented roster (names only) — so any agent can LOCATE
 *  anyone and see the path to them, even outside its own branch. */
export function renderOrgRoster(tree: OrgNode[]): string {
  const lines: string[] = []
  const walk = (nodes: OrgNode[], depth: number) => {
    for (const n of nodes) {
      lines.push(`${'  '.repeat(depth)}- ${n.role.title} (\`${n.role.key}\`)${n.role.folder ? ' [folder]' : ''}`)
      if (n.children.length) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  return lines.join('\n')
}

/** A role's place in the org, injected into its system prompt so it permanently
 *  knows (a) the NAMES of everyone (the full roster, to locate anyone) and (b)
 *  the short DESCRIPTIONS of just its immediate neighbours (manager + direct
 *  reports). Computed at spawn; reparents apply on the next reload (the role
 *  file's frontmatter `manager` is the live source of truth). */
export function buildOrgPosition(opts: {
  self?: { key: string; title: string }
  roster: string
  manager: { key: string; title: string; desc?: string } | null
  reports: Array<{ key: string; title: string; desc?: string; folder?: boolean }>
}): string {
  const lines: string[] = ['# The org chart (everyone — so you can locate anyone)']
  if (opts.roster) lines.push(opts.roster)
  lines.push('')
  lines.push('To reach someone NOT directly below you: assign to YOUR direct report whose branch contains them and let them route deeper. Never reach past a level.')
  lines.push('')
  lines.push('# Your place')
  if (opts.self) {
    lines.push(`- **You are:** ${opts.self.title} (\`${opts.self.key}\`) · your durable role file is \`~/.config/console/agents/${opts.self.key}.md\` — Read/Edit it to keep your charter + \`## Memory\` current (this is how you persist what you learn across sessions). Your own agentKey — the \`@key\` others assign board cards to — is \`${opts.self.key}\`.`)
  }
  lines.push(
    opts.manager
      ? `- **You report to:** ${opts.manager.title} (\`${opts.manager.key}\`)${opts.manager.desc ? ` — ${opts.manager.desc}` : ''}.`
      : '- **You are the org root** (no manager).',
  )
  const real = opts.reports.filter((r) => !r.folder)
  const folders = opts.reports.filter((r) => r.folder)
  if (real.length || folders.length) {
    lines.push('- **Your direct reports** (route work DOWN to these via board cards):')
    for (const r of [...real, ...folders]) {
      lines.push(`  - ${r.title} (\`${r.key}\`)${r.folder ? ' [folder]' : ''}${r.desc ? ` — ${r.desc}` : ''}`)
    }
  } else {
    lines.push('- **You have no direct reports** — you are a leaf; do the work yourself.')
  }
  lines.push('Do not skip levels.')
  return lines.join('\n')
}
