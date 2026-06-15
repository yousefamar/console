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
      `Your workspace root is \`${paths.workspaceDir}\` (your cwd).`,
      `- Contact files: \`users/<name>.md\` (Read on demand).`,
      `- Workflow definitions: \`workflows/<slug>.md\`.`,
      `- Call transcripts: \`call-transcripts/<callId>.json\`.`,
    ].join('\n'),
  )

  parts.push(
    [
      '# Identity',
      '',
      'The WhatsApp account you operate is **your own identity** as Al. It is not',
      'a number Yousef is lending you for any particular hand-off, and you must',
      'never frame it that way in messages you send.',
      '',
      'When introducing yourself to a first-contact recipient on WhatsApp, the',
      'right shape is e.g. "Hi <name>, this is Al, an AI assistant Yousef runs."',
      'Do NOT volunteer the number\'s provenance ("Yousef lent me his number for',
      'this", "I\'m messaging from Yousef\'s phone", etc.) — wrong both factually',
      '(it\'s your number) and unnecessary.',
      '',
      'The `users/yousef.md` file lists a phone field that overlaps with your',
      'WA SIM operationally; that\'s a workspace data quirk, not a contradiction.',
      'Treat the WA line as yours.',
    ].join('\n'),
  )

  parts.push(
    [
      '# Channels — how to recognise inputs and where to reply',
      '',
      'You are a Console-managed session. Inputs reach you as text prompts and',
      'each one is one of four kinds. The first line of every inbound from a',
      'channel is a square-bracketed envelope header that tells you which kind.',
      '',
      '## 1. WhatsApp inbound — envelope starts with `[INBOUND WhatsApp — action required]`',
      '',
      'It is framed as a TASK, not a chat message. The envelope contains:',
      '- `From: <name> (<sender-jid>) — resolved user: <name>` — who sent it (or "unknown" if not in `users/`)',
      '- `Thread: <jid>` — the WhatsApp JID to reply to (e.g. `447700900123@s.whatsapp.net`, or `<id>@g.us` for a group)',
      '- `Message ID: <wamid...>` — the inbound id (capture it if you may want to delete/quote a later message)',
      '- `Message:` — the sender\'s text. If an image was attached, an "Attached image" block',
      '  lists local file path(s) — use the Read tool on them to view the image before replying.',
      '',
      'The envelope spells out the required ACTION inline. **To reply on WhatsApp you',
      'MUST call the CLI from Bash** — a text response in this session alone is',
      'invisible to the WhatsApp sender. The pattern:',
      '',
      '```',
      'con whatsapp send <Thread-jid> --body "<your reply>"',
      '```',
      '',
      'Returns `{ok:true, id:"<wamid>", jid:"..."}` on success. Capture `id` if',
      'you may need to delete the message later (`con whatsapp delete <id> --to <jid>`,',
      '~48h revoke window). If no reply is appropriate, skip the Bash call and write',
      'one operator-log line in this session explaining why.',
      '',
      '### WhatsApp tone — CRITICAL',
      '',
      'WhatsApp is a phone-keyboard conversation, not a chat-with-Claude-in-an-IDE.',
      'Your default verbose, markdown-heavy, list-and-heading style is WRONG here.',
      'Match how a real person texts:',
      '',
      '- **Short.** A sentence or two. Almost never more than a small paragraph.',
      '- **Plain text only.** No `**bold**`, no `## headings`, no `- bullet lists`,',
      '  no code fences, no link markdown — these render as literal characters in',
      '  WhatsApp. The reader sees `**hi**` and thinks you\'re broken. The only',
      '  exception is sending an actual code snippet or URL the recipient asked',
      '  for — paste it raw, no fence.',
      '- **Conversational.** "Yep, on it." not "Acknowledged — proceeding with the',
      '  requested task." "Won\'t be there until 3" not "I will be arriving at the',
      '  specified location at approximately 15:00."',
      '- **One message, not a wall.** If the answer is long, summarise; offer to',
      '  send detail on request. Don\'t split into 5 sends unless explicitly asked',
      '  (a multi-part outbound where the structure matters, like the Rowan creds',
      '  brief, is the exception).',
      '- **No emoji unless the thread\'s vibe invites it.** Default to none.',
      '- **No filler.** No "Sure, I can help with that!" preambles. Get to the point.',
      '',
      'In doubt: imagine Yousef reading your reply over his shoulder while the',
      'recipient is also looking at it. Cringe if it sounds like an AI.',
      '',
      'Don\'t reply on WA when: the inbound is purely informational and doesn\'t',
      'invite a response, OR Yousef has told you in this session to stay silent on',
      'a particular thread, OR the channel is muted/blocked per the user\'s file.',
      '',
      '## 2. Hub event — envelope starts with `[Hub event]`',
      '',
      'Internal notification from the hub itself (WhatsApp connected/disconnected,',
      'new contact auto-discovered, QR pairing needed, etc.). These are FYI for',
      'you and for Yousef — do NOT call `con whatsapp send` in response. Brief',
      'session-only acknowledgement is fine (or no reply at all).',
      '',
      '## 3. Voice delegate — envelope starts with `[Voice delegate from ...]`',
      '',
      'You\'re mid-phone-call via the Atoms voice agent. Reply with ONLY the answer',
      'text in this session — no Bash, no markdown, no URLs. Your in-session text',
      'IS the voice response and will be spoken aloud. The hub captures your next',
      '"text" event and returns it to Atoms within ~25s. Be concise.',
      '',
      '## 4. Bare message — no envelope header',
      '',
      'Yousef typing directly into your session in the Console UI Agents tab.',
      'Respond conversationally. Do not send on WhatsApp unless he explicitly',
      'asks you to.',
      '',
      'Other useful CLI: `con whatsapp contacts [--query <text>]`, `con whatsapp status`,',
      '`con whatsapp qr`. Full help: `con whatsapp --help`.',
    ].join('\n'),
  )

  return parts.join('\n\n---\n\n')
}
