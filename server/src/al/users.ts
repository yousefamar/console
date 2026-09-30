// Per-user lookup map: JID / phone / Slack-ID → username + file + allow-list.
//
// Source of truth = `~/.local/share/al/workspace/users/*.md`, each file's
// frontmatter listing one or more identifiers (whatsapp, phone, slack).
// Yousef's `users/yousef.md` carries BOTH his SIM phone and his iPad's `@lid`
// identifier; without that, iPad-sent messages get treated as non-owner and
// Al refuses to do anything (footgun #1).

import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { WORKSPACE_DIR } from './identity.js'
import * as identity from './wa-identity.js'

const IDENTIFIER_KEYS = new Set(['whatsapp', 'slack', 'phone'])

export interface UserEntry {
  username: string
  filePath: string
  allow: string[]
}

let lookupMap: Map<string, UserEntry> | null = null
let loadedSignature = ''
let notifyCallback: ((text: string) => void) | null = null
let usersWatcher: FSWatcher | null = null
let watchRefreshTimer: ReturnType<typeof setTimeout> | null = null
const writeBacksInFlight = new Set<string>()

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

  // A note that lists one WhatsApp id gets the other half of its lid↔phone
  // pair, so the contact resolves from either JID and identifiersFor() spans
  // both threads. The id also goes into the note (below) so it is visible
  // there and survives without this map.
  for (const [id, entry] of [...map]) {
    const alt = identity.alternateFor(id)
    if (!alt) continue
    const owner = map.get(alt)
    if (owner === entry) continue
    if (owner) {
      console.warn(`[al/users] ${id} (${entry.username}) and ${alt} (${owner.username}) are one WhatsApp contact — duplicate notes`)
      continue
    }
    map.set(alt, entry)
    scheduleWriteBack(entry, alt, id)
  }

  return map
}

/** Strip WhatsApp suffix (@s.whatsapp.net | @lid | @c.us | @g.us) + leading +. */
export function normalize(senderId: string): string {
  return senderId.replace(/@(s\.whatsapp\.net|lid|c\.us|g\.us)$/, '').replace(/^\+/, '')
}

/** Direct hit, else the note that lists this id's lid↔phone alternate (the
 *  contact wrote from the other JID). A hit through the alternate is adopted:
 *  the id joins the in-memory map now and the note on disk shortly after. */
function resolveEntry(senderId: string): UserEntry | null {
  if (!lookupMap) return null
  const id = normalize(senderId)
  const direct = lookupMap.get(id)
  if (direct) return direct
  const alt = identity.alternateFor(id)
  const viaAlt = alt ? lookupMap.get(alt) : undefined
  if (!alt || !viaAlt) return null
  adopt(viaAlt, id, alt)
  return viaAlt
}

function adopt(entry: UserEntry, id: string, knownAs: string): void {
  lookupMap?.set(id, entry)
  console.log(`[al/users] ${id} is ${entry.username} (same contact as ${knownAs} per the lid↔phone map)`)
  scheduleWriteBack(entry, id, knownAs)
}

/** `resolveEntry` plus a fresh read of users/*.md first and, when both
 *  on-disk stores miss, a USync ask to WhatsApp for the caller's other JID.
 *  For the paths with a moment to spare: ring time, an inbound message. */
export async function resolveUserLive(senderId: string): Promise<UserEntry | null> {
  await refreshUsers()
  const found = resolveEntry(senderId)
  if (found || !lookupMap) return found
  const id = normalize(senderId)
  const alt = await identity.discoverAlternate(id)
  const viaAlt = alt ? lookupMap.get(alt) : undefined
  if (!alt || !viaAlt) return null
  adopt(viaAlt, id, alt)
  return viaAlt
}

export function resolveUserFile(senderId: string): string | null {
  return resolveEntry(senderId)?.filePath ?? null
}

export function resolveUsername(senderId: string): string | null {
  return resolveEntry(senderId)?.username ?? null
}

export function resolveAllow(senderId: string): string[] {
  return resolveEntry(senderId)?.allow ?? []
}

/** `content` with `id` added under the frontmatter's `whatsapp:` key — a
 *  list item appended, a scalar promoted to a list, a missing key created.
 *  Textual, so the rest of the note (and its formatting) is untouched. Null
 *  when the id is already listed or the result does not parse back. */
export function withWhatsappIdentifier(content: string, id: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const fm = m[1]!
  const current = parseFrontmatter(content)
  const listed = Array.isArray(current.whatsapp) ? current.whatsapp : typeof current.whatsapp === 'string' ? [current.whatsapp] : []
  if (listed.includes(id)) return null
  const lines = fm.split('\n')
  const keyAt = lines.findIndex((l) => /^whatsapp:/.test(l))
  let next: string[]
  if (keyAt === -1) {
    next = [...lines, 'whatsapp:', `  - "${id}"`]
  } else {
    const rest = lines[keyAt]!.slice('whatsapp:'.length).replace(/\s+#.*$/, '').trim()
    if (rest === '' || rest === '|' || rest === '>') {
      let end = keyAt + 1
      let indent = '  '
      while (end < lines.length && /^\s+-\s/.test(lines[end]!)) {
        indent = lines[end]!.match(/^\s+/)![0]
        end++
      }
      next = [...lines.slice(0, end), `${indent}- "${id}"`, ...lines.slice(end)]
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      next = [...lines.slice(0, keyAt), `whatsapp: [${inner ? `${inner}, ` : ''}"${id}"]`, ...lines.slice(keyAt + 1)]
    } else {
      next = [...lines.slice(0, keyAt), 'whatsapp:', `  - ${rest}`, `  - "${id}"`, ...lines.slice(keyAt + 1)]
    }
  }
  const out = `---\n${next.join('\n')}\n---${content.slice(m[0].length)}`
  const check = parseFrontmatter(out)
  const after = Array.isArray(check.whatsapp) ? check.whatsapp : typeof check.whatsapp === 'string' ? [check.whatsapp] : []
  return after.includes(id) && listed.every((v) => after.includes(v)) ? out : null
}

function scheduleWriteBack(entry: UserEntry, id: string, knownAs: string): void {
  const key = `${entry.filePath}:${id}`
  if (writeBacksInFlight.has(key)) return
  writeBacksInFlight.add(key)
  void (async () => {
    try {
      const content = await readFile(entry.filePath, 'utf-8')
      const out = withWhatsappIdentifier(content, id)
      if (!out) return
      const tmp = `${entry.filePath}.${process.pid}.tmp`
      await writeFile(tmp, out, 'utf-8')
      await rename(tmp, entry.filePath)
      console.log(`[al/users] wrote ${id} into ${entry.filePath} (lid↔phone pair of ${knownAs})`)
    } catch (err) {
      console.error(`[al/users] write-back of ${id} to ${entry.filePath} failed:`, (err as Error)?.message)
    } finally {
      writeBacksInFlight.delete(key)
    }
  })()
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
  watchUsersDir()
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

/** Every resolver is synchronous and most callers never think to refresh, so
 *  a note edit lands through inotify instead: AL added Rebaz's phone to his
 *  note and the next call was still "unknown number" (30 Sept 2026). */
function watchUsersDir(): void {
  if (usersWatcher) return
  try {
    usersWatcher = watch(join(WORKSPACE_DIR, 'users'), { persistent: false }, () => {
      if (watchRefreshTimer) clearTimeout(watchRefreshTimer)
      watchRefreshTimer = setTimeout(() => {
        watchRefreshTimer = null
        refreshUsers().catch((err) => console.error('[al/users] watch refresh failed:', (err as Error)?.message))
      }, 300)
    })
    usersWatcher.on('error', (err) => {
      console.error('[al/users] users/ watcher error:', err.message)
      usersWatcher = null
    })
  } catch (err) {
    console.error('[al/users] cannot watch users/:', (err as Error)?.message)
  }
}

export async function ensureUserKnown(
  senderId: string,
  channel: 'whatsapp' | 'slack' | 'voice' | 'console',
  senderName?: string,
): Promise<void> {
  if (!lookupMap) return
  const normalized = normalize(senderId)
  if (lookupMap.has(normalized)) return
  // A note written by hand since boot, or one that knows this contact by
  // their other JID, must not become a duplicate auto-created file.
  if (await resolveUserLive(senderId)) return

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
  // Both halves of a known lid↔phone pair from the start.
  const alt = channel === 'whatsapp' || channel === 'voice' ? identity.alternateFor(normalized) : null
  const ids = alt ? [normalized, alt] : [normalized]
  const content = [
    '---',
    ...(ids.length === 1 ? [`${identifierKey}: "${normalized}"`] : ['whatsapp:', ...ids.map((v) => `  - "${v}"`)]),
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
  for (const v of ids) lookupMap.set(v, entry)

  console.log(`[al/users] auto-discovered: ${displayName} -> ${filePath}`)
  notifyCallback?.(`New contact: ${displayName} (${channel}: ${normalized})`)
}
