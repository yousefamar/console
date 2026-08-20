// ============================================================================
// Org protocol — the runtime "who you are + how work flows" every agent gets.
//
// `buildBoardProtocol()` is appended to the system prompt of every fresh agent
// spawn (the createSession choke point) and to Al's persona. Work assignment
// is BOARD-DRIVEN: each project has a markdown kanban board in the vault
// (Obsidian Kanban format); assigning a card to an agent (`@agentkey` on the
// line, card under `## In Progress`) is the delegation, and the agent editing
// its line into `## Under Review` is the report. Plain text, human- and agent-editable
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
    '- **Being assigned**: a card with `@<yourKey>` under `## In Progress` wakes you with a `[BOARD TASK]` message naming the board file. Do the work, then EDIT THE BOARD: move your line under `## Under Review` — a human (or your manager) verifies it and moves it to `## Done`; NEVER move your own card to Done. Stuck? Append `#blocked` to your line (it keeps its column) with an indented note below explaining what you need; remove the tag when unblocked. Always keep the trailing `^id` token on your line — it is the card\'s identity.',
    '- **Assigning others**: add a card to the relevant project board with `@<theirKey>` and put it under `## In Progress` — the hub dispatches it. Under `## Backlog` it is merely planned (not dispatched) until someone moves it. Forks are assignable too (a fork\'s `@key` is its own).',
    '- **Dispatch auto-forks**: when a card is dispatched to a role with a LIVE session, the hub forks that session — the fork inherits full context, owns the card (its own `@key` is stamped onto the line), and works the ticket in its own worktree while the main session stays free. So to parallelize your own work, assign a card to YOURSELF under `## In Progress`: the hub spawns a fork of you per card. No manual forking needed.',
    '- **Working through your own queue**: grep the board for `@<yourKey>` — those lines are YOUR tasks, whatever column they sit in. When told to "work through your tasks", process your assigned cards (Backlog ones included) in order, moving each to Under Review (or tagging `#blocked`) as you go.',
    '- **Worktree discipline**: for code work of any substance, isolate first: `autowt switch <ticket-slug> --terminal echo -y` prints a fresh worktree path (aliased `wt`; no terminal opens). Work THERE — run your own dev server and your own tests inside it. When done, fold the work back into the project\'s main branch per that repo\'s convention (Console: commits land on `main`, branches never survive), then `autowt cleanup <ticket-slug> -y`. You decide per ticket whether it warrants a worktree — trivial doc edits don\'t; anything touching shared running code does.',
    '- **Planning**: cards without an `@key` are unassigned; boards are as much Yousef\'s as yours. Edit boards with normal file tools; keep the format intact (the file round-trips through Obsidian).',
    '- **Deploy-gated boards**: a board whose frontmatter has `deploy_gate: review` belongs to a repo where merging to main DEPLOYS (e.g. Vercel-on-main). On those: never merge to main yourself — push your branch, note the branch + preview URL on the card when moving it to Under Review, and merge only after the card owner approves.',
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
