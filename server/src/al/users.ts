// Per-user lookup map: JID / phone / Slack-ID → username + file + allow-list.
//
// Source of truth = `~/.local/share/al/workspace/users/*.md`, each file's
// frontmatter listing one or more identifiers (whatsapp, phone, slack).
// Yousef's `users/yousef.md` carries BOTH his SIM phone and his iPad's `@lid`
// identifier; without that, iPad-sent messages get treated as non-owner and
// Al refuses to do anything (footgun #1).

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKSPACE_DIR } from './identity.js'

const IDENTIFIER_KEYS = new Set(['whatsapp', 'slack', 'phone'])

export interface UserEntry {
  username: string
  filePath: string
  allow: string[]
}

let lookupMap: Map<string, UserEntry> | null = null
let notifyCallback: ((text: string) => void) | null = null

/** Inject a callback used by `ensureUserKnown` to ping Al about new contacts. */
export function setUserNotifier(cb: (text: string) => void): void {
  notifyCallback = cb
}

function parseFrontmatter(content: string): Record<string, string | string[]> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return {}
  const result: Record<string, string | string[]> = {}
  let listKey: string | null = null

  for (const line of match[1].split('\n')) {
    if (listKey && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '')
      if (val) (result[listKey] as string[]).push(val)
      continue
    }
    listKey = null

    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')

    if (key && !val) {
      result[key] = []
      listKey = key
    } else if (key && val) {
      result[key] = val
    }
  }
  return result
}

async function buildLookupMap(): Promise<Map<string, UserEntry>> {
  const map = new Map<string, UserEntry>()
  const usersDir = join(WORKSPACE_DIR, 'users')

  let files: string[]
  try {
    files = await readdir(usersDir)
  } catch {
    return map
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const username = file.replace(/\.md$/, '')
    const filePath = join(usersDir, file)

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      continue
    }

    const frontmatter = parseFrontmatter(content)
    const allow = Array.isArray(frontmatter.allow) ? frontmatter.allow : []
    const entry: UserEntry = { username, filePath, allow }

    for (const [key, val] of Object.entries(frontmatter)) {
      if (!IDENTIFIER_KEYS.has(key)) continue
      const values = Array.isArray(val) ? val : typeof val === 'string' ? [val] : []
      for (const v of values) map.set(v, entry)
    }
  }

  return map
}

/** Strip WhatsApp suffix (@s.whatsapp.net | @lid | @c.us | @g.us) + leading +. */
export function normalize(senderId: string): string {
  return senderId.replace(/@(s\.whatsapp\.net|lid|c\.us|g\.us)$/, '').replace(/^\+/, '')
}

export function resolveUserFile(senderId: string): string | null {
  if (!lookupMap) return null
  return lookupMap.get(normalize(senderId))?.filePath ?? null
}

export function resolveUsername(senderId: string): string | null {
  if (!lookupMap) return null
  return lookupMap.get(normalize(senderId))?.username ?? null
}

export function resolveAllow(senderId: string): string[] {
  if (!lookupMap) return []
  return lookupMap.get(normalize(senderId))?.allow ?? []
}

export async function loadUsers(): Promise<void> {
  lookupMap = await buildLookupMap()
  console.log(`[al/users] loaded ${lookupMap.size} identifier(s) from workspace`)
}

export async function ensureUserKnown(
  senderId: string,
  channel: 'whatsapp' | 'slack' | 'voice' | 'console',
  senderName?: string,
): Promise<void> {
  if (!lookupMap) return
  const normalized = normalize(senderId)
  if (lookupMap.has(normalized)) return

  const displayName = senderName || normalized
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  const usersDir = join(WORKSPACE_DIR, 'users')
  let filename = slug
  let counter = 1
  try {
    const existing = await readdir(usersDir)
    while (existing.includes(`${filename}.md`)) {
      filename = `${slug}-${counter++}`
    }
  } catch {
    // workspace missing — give up silently
    return
  }

  const filePath = join(usersDir, `${filename}.md`)
  const identifierKey = channel === 'voice' ? 'phone' : channel
  const content = [
    '---',
    `${identifierKey}: "${normalized}"`,
    '---',
    '',
    `## ${displayName}`,
    '',
    `First contacted Al on ${new Date().toISOString().slice(0, 10)}.`,
    '',
  ].join('\n')

  try {
    await writeFile(filePath, content, 'utf-8')
  } catch (err) {
    console.error(`[al/users] failed to auto-create ${filePath}:`, (err as Error).message)
    return
  }

  const entry: UserEntry = { username: filename, filePath, allow: [] }
  lookupMap.set(normalized, entry)

  console.log(`[al/users] auto-discovered: ${displayName} -> ${filePath}`)
  notifyCallback?.(`New contact: ${displayName} (${channel}: ${normalized})`)
}
