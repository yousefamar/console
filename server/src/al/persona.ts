// Al persona / system-prompt assembly.
//
// The Al Console session is spawned with a fixed system prompt composed at
// boot time. No fs.watch, no live reload — Claude system prompts are fixed at
// session creation. Edits to persona files land via `con agent restart Al`.
//
// Composition order (concatenated with `\n\n---\n\n`):
//   1. Verbatim AL.md (persona, decision rules, hard rules)
//   2. mistakes.md under `# Past mistakes (do not repeat)`
//   3. Auto-built `# Available workflows` (walks workflows/, takes first
//      non-blank line as a one-liner per workflow; Al reads full on demand)
//   4. `# Workspace` block — absolute path constant so Al can Read on demand

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKSPACE_DIR, readIfExists } from './identity.js'

const WORKFLOW_TEMPLATES = new Set(['TEMPLATE.md'])

async function buildWorkflowsBlock(): Promise<string | null> {
  const workflowsDir = join(WORKSPACE_DIR, 'workflows')
  let files: string[]
  try {
    files = await readdir(workflowsDir)
  } catch {
    return null
  }
  const lines: string[] = []
  for (const f of files.filter((n) => n.endsWith('.md') && !WORKFLOW_TEMPLATES.has(n)).sort()) {
    const content = await readIfExists(join(workflowsDir, f))
    if (!content) continue
    const slug = f.replace(/\.md$/, '')
    // First non-blank line, strip leading hashes + spaces. Falls back to slug.
    const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
    const desc = firstLine.replace(/^#+\s*/, '').trim() || slug
    lines.push(`- ${slug} — ${desc}`)
  }
  if (lines.length === 0) return null
  return `# Available workflows\n\nRead the full file at \`${workflowsDir}/<slug>.md\` when you need to follow one.\n\n${lines.join('\n')}`
}

export interface PersonaPaths {
  workspaceDir: string
  alMdPath: string
  usersDir: string
  workflowsDir: string
  transcriptsDir: string
}

export function getPersonaPaths(): PersonaPaths {
  return {
    workspaceDir: WORKSPACE_DIR,
    alMdPath: join(WORKSPACE_DIR, 'AL.md'),
    usersDir: join(WORKSPACE_DIR, 'users'),
    workflowsDir: join(WORKSPACE_DIR, 'workflows'),
    transcriptsDir: join(WORKSPACE_DIR, 'call-transcripts'),
  }
}

/**
 * Build the Al system prompt. Synchronous reads via readFile (under the hood)
 * keep call-site simple; total bytes are small (AL.md ~5 KB, mistakes.md a few
 * hundred bytes, workflows list a one-liner each).
 */
export async function buildAlSystemPrompt(): Promise<string> {
  const paths = getPersonaPaths()
  const parts: string[] = []

  const alMd = await readIfExists(paths.alMdPath)
  if (alMd) parts.push(alMd.trim())

  const mistakes = await readIfExists(join(paths.workspaceDir, 'mistakes.md'))
  if (mistakes && mistakes.trim()) {
    parts.push(`# Past mistakes (do not repeat)\n\n${mistakes.trim()}`)
  }

  const workflows = await buildWorkflowsBlock()
  if (workflows) parts.push(workflows)

  parts.push(
    [
      '# Workspace',
      '',
      `Your workspace root is \`${paths.workspaceDir}\`.`,
      `- Contact files: \`${paths.usersDir}/<name>.md\` (Read on demand).`,
      `- Workflow definitions: \`${paths.workflowsDir}/<slug>.md\`.`,
      `- Call transcripts: \`${paths.transcriptsDir}/<callId>.json\`.`,
      '',
      'To send WhatsApp, use `con whatsapp send <to> --body "..."` from Bash.',
      'See `con whatsapp --help` for delete / contacts / qr.',
    ].join('\n'),
  )

  return parts.join('\n\n---\n\n')
}
