// Per-user lookup map: JID / phone / Slack-ID → username + file + allow-list.
//
// Source of truth = `~/.local/share/al/workspace/users/*.md`, each file's
// frontmatter listing one or more identifiers (whatsapp, phone, slack).
// Yousef's `users/yousef.md` carries BOTH his SIM phone and his iPad's `@lid`
// identifier; without that, iPad-sent messages get treated as non-owner and
// Al refuses to do anything (footgun #1).

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { WORKSPACE_DIR } from './identity.js'

const IDENTIFIER_KEYS = new Set(['whatsapp', 'slack', 'phone'])

export interface UserEntry {
  username: string
  filePath: string
  allow: string[]
}

let lookupMap: Map<string, UserEntry> | null = null
let loadedSignature = ''
let notifyCallback: ((text: string) => void) | null = null

/** Inject a callback used by `ensureUserKnown` to ping Al about new contacts. */
export function setUserNotifier(cb: (text: string) => void): void {
  notifyCallback = cb
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v)
  return null
}

export function parseFrontmatter(content: string, file = '<inline>'): Record<string, string | string[]> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) return {}
  let doc: unknown
  try {
    // bigint so an unquoted 15-digit @lid id survives with every digit intact
    doc = parseYaml(match[1], { intAsBigInt: true })
  } catch (err) {
    console.error(`[al/users] bad frontmatter in ${file}: ${(err as Error).message}`)
    return {}
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {}

  const result: Record<string, string | string[]> = {}
  for (const [key, val] of Object.entries(doc as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      result[key] = val.map(scalar).filter((s): s is string => s !== null)
    } else {
      const s = scalar(val)
      if (s !== null) result[key] = s
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

    const frontmatter = parseFrontmatter(content, filePath)
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

/** Every identifier a user's file lists (normalized), or [] when unknown. */
export function identifiersFor(username: string | null): string[] {
  if (!lookupMap || !username) return []
  const out: string[] = []
  for (const [id, entry] of lookupMap) if (entry.username === username) out.push(id)
  return out
}

/** Names + mtimes + sizes of every users/*.md — changes whenever a note is
 *  added, removed or edited. A readdir plus ~20 stats. */
async function usersSignature(): Promise<string> {
  const usersDir = join(WORKSPACE_DIR, 'users')
  let files: string[]
  try {
    files = (await readdir(usersDir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return ''
  }
  const stats = await Promise.all(files.map((f) => stat(join(usersDir, f)).catch(() => null)))
  return files.map((f, i) => `${f}:${stats[i]?.mtimeMs ?? 0}:${stats[i]?.size ?? 0}`).join('\n')
}

export async function loadUsers(): Promise<void> {
  loadedSignature = await usersSignature()
  lookupMap = await buildLookupMap()
  console.log(`[al/users] loaded ${lookupMap.size} identifier(s) from workspace`)
}

/** Rebuild the map when any users/*.md changed since it was loaded. The notes
 *  are edited by hand (a contact's @lid added after a DM room failed to
 *  resolve) and by AL himself; a boot-only map made every such edit wait for
 *  a hub restart. Cheap enough for the inbound path. */
export async function refreshUsers(): Promise<void> {
  if (!lookupMap) return
  const sig = await usersSignature()
  if (sig === loadedSignature) return
  loadedSignature = sig
  lookupMap = await buildLookupMap()
  console.log(`[al/users] reloaded ${lookupMap.size} identifier(s) — users/*.md changed`)
}

export async function ensureUserKnown(
  senderId: string,
  channel: 'whatsapp' | 'slack' | 'voice' | 'console',
  senderName?: string,
): Promise<void> {
  if (!lookupMap) return
  const normalized = normalize(senderId)
  if (lookupMap.has(normalized)) return
  // A note written by hand since boot must not become a duplicate auto-created file.
  await refreshUsers()
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
