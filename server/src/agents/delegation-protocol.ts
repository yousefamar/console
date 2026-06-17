// ============================================================================
// Delegation protocol — the runtime "how to communicate" every agent receives.
//
// `buildDelegationProtocol()` is appended to the system prompt of every fresh
// agent spawn (the createSession choke point) and to Al's persona, so the whole
// fleet speaks the same delegate/report verbs without relying on CLAUDE.md
// discovery. The envelope builders frame inbound delegations/reports as
// self-instructing tasks (the analog of Al's WhatsApp inbound envelope).
// ============================================================================

import type { AgentTask } from './tasks.js'
import type { OrgNode } from './registry.js'

/** The standing protocol stanza — kept tight (token cost is paid per spawn). */
export function buildDelegationProtocol(): string {
  return [
    '# Delegation protocol',
    '',
    'You are part of an org chart. Work flows down via delegation and results report back up.',
    '',
    "- **Delegate** anything better handled by a report (or that would clutter your context): `con agent delegate <agentKey> \"<brief>\" [--title T]`. It returns a task id and runs async — you are NOT blocked.",
    '  - To a brand-new agent: `con agent delegate --new "<title>" --cwd <dir> [--manager <key>] "<brief>"`.',
    '  - For a throwaway parallel worker (no accrued memory): add `--ephemeral`.',
    '- **Report** when you finish work that was delegated to you: `con agent report <taskId> "<concise result>"`. Use `--status blocked "<what you need>"` if stuck.',
    '- **Inspect**: `con agent tasks` (what you owe / are owed); `con agent tasks --children <taskId>` (sub-tasks you delegated).',
    '',
    'Rules:',
    "- Keep results CONCISE — a summary + a pointer, not a transcript. Your delegator's context is precious.",
    '- **If a delegated task belongs to (or names) one of your reports, you MUST re-delegate it to them** — `con agent delegate <reportKey> "<brief>" --from <yourKey> --parent <taskId>` — wait for their report, then report up. NEVER answer on a report\'s behalf or declare yourself the terminal node when the work is theirs.',
    '- If you delegated sub-tasks, wait until all of `con agent tasks --children <taskId>` are done, then synthesize and report up to the parent task.',
    "- Inbound tasks arrive as `[DELEGATED TASK]` messages; results arrive as `[REPORT]` messages. They are instructions, act on them.",
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
  lines.push('To reach someone NOT directly below you: delegate to YOUR direct report whose branch contains them and let them route deeper. Never reach past a level.')
  lines.push('')
  lines.push('# Your place')
  if (opts.self) {
    lines.push(`- **You are:** ${opts.self.title} (\`${opts.self.key}\`) · your durable role file is \`~/.config/console/agents/${opts.self.key}.md\` — Read/Edit it to keep your charter + \`## Memory\` current (this is how you persist what you learn across sessions). Your own agentKey for \`--from\` on delegations is \`${opts.self.key}\`.`)
  }
  lines.push(
    opts.manager
      ? `- **You report to:** ${opts.manager.title} (\`${opts.manager.key}\`)${opts.manager.desc ? ` — ${opts.manager.desc}` : ''}. Report results/escalations UP with \`con agent report <taskId> …\`.`
      : '- **You are the org root** (no manager).',
  )
  const real = opts.reports.filter((r) => !r.folder)
  const folders = opts.reports.filter((r) => r.folder)
  if (real.length || folders.length) {
    lines.push('- **Your direct reports** (delegate work DOWN to these):')
    for (const r of [...real, ...folders]) {
      lines.push(`  - ${r.title} (\`${r.key}\`)${r.folder ? ' [folder]' : ''}${r.desc ? ` — ${r.desc}` : ''}`)
    }
  } else {
    lines.push('- **You have no direct reports** — you are a leaf; do the work yourself and report up.')
  }
  lines.push('Do not skip levels.')
  return lines.join('\n')
}

/** Inbound delegation, injected into the assignee's session. `chainLabel` is the
 *  human-readable path (titles), e.g. "Yousef → Al → Engineering → you". */
export function buildDelegationEnvelope(opts: { task: AgentTask; fromTitle: string; chainLabel: string; reports?: Array<{ key: string; title: string }> }): string {
  const { task, fromTitle, chainLabel, reports = [] } = opts
  const lines = [
    '[DELEGATED TASK — action required]',
    `Task: ${task.id}   From: ${fromTitle} (${task.fromKey})   Chain: ${chainLabel}`,
    `Title: ${task.title}`,
    '',
    task.brief,
    '',
  ]
  if (reports.length) {
    // The assignee is a MANAGER. Make routing-onward mandatory + spell out the
    // exact command, so it can't short-circuit by answering on a report's behalf
    // (even if its session predates the delegation protocol).
    lines.push(`You manage: ${reports.map((r) => `${r.title} (\`${r.key}\`)`).join(', ')}.`)
    lines.push(`**If this task is for — or names — one of them, you MUST re-delegate it down and NOT answer on their behalf or declare yourself the terminal node.** Hand it to the report, wait for their report back, then report up to your delegator:`)
    lines.push(`    con agent delegate <reportKey> "<brief, addressed to them>" --from ${task.toKey} --parent ${task.id}`)
    lines.push(`Then once they report to you, run \`con agent report ${task.id} "<their result + any synthesis>"\`. Only do the work yourself if no report owns it.`)
    lines.push('')
  }
  lines.push(`When the work is truly done${reports.length ? ' (yours, or relayed up from a report)' : ''}: con agent report ${task.id} "<concise result>"`)
  lines.push(`If blocked or you need input: con agent report ${task.id} --status blocked "<what you need>"`)
  return lines.join('\n')
}

/** Inbound report, injected into the delegator's session. `isAlTop` = this task
 *  was the top of a human-originated chain owned by Al (→ relay to Yousef). */
export function buildReportEnvelope(opts: { task: AgentTask; fromTitle: string; isAlTop: boolean }): string {
  const { task, fromTitle, isAlTop } = opts
  const lines = [
    `[REPORT — task ${task.id} from ${fromTitle} (${task.toKey})]  status: ${task.status}`,
    '',
    task.result ?? '(no result text)',
    '',
  ]
  if (isAlTop) {
    lines.push('This completes work Yousef asked for. Relay the outcome to him in plain language (and `@amar` if he is away).')
  } else if (task.parentTaskId) {
    lines.push(`This is a sub-task of ${task.parentTaskId}. When all of \`con agent tasks --children ${task.parentTaskId}\` are done, synthesize and run \`con agent report ${task.parentTaskId} "<summary>"\`.`)
  } else {
    lines.push('Decide what to do with this result — relay it up, act on it, or close it out.')
  }
  return lines.join('\n')
}
