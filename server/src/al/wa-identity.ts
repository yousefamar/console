// Phone ↔ @lid identity map for WhatsApp contacts.
//
// One person reaches AL under two JIDs: the phone (`447…@s.whatsapp.net`,
// what a call or a phone-sent message carries) and the linked-device lid
// (`150…@lid`, what Beeper rooms and Web/Desktop sends carry). A users/*.md
// written from a Beeper room knows only the lid, so a call from the phone
// resolved to nobody (Rebaz, 30 Sept 2026) — even though BOTH WhatsApp
// clients on this machine already held the pair: Baileys in its multi-file
// auth store (`lid-mapping-<pn>.json` / `lid-mapping-<lid>_reverse.json`,
// wiped with the rest of the store on logout) and wa-voice in its SQLite
// (`lid_pn_mapping`, seeded by history sync). This module merges both into
// one hub-owned map, learns live pairs from Baileys' `lid-mapping.update`,
// persists the union so it outlives a re-pair, and answers "the other JID of
// this contact" for the user resolver.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { AUTH_WHATSAPP_DIR } from './identity.js'

function identityFile(): string {
  return process.env.CONSOLE_WA_IDENTITY_FILE || join(homedir(), '.config', 'console', 'wa-identity.json')
}

function waVoiceDb(): string {
  const dir = process.env.WA_VOICE_STORE_DIR || join(homedir(), '.config', 'console', 'wa-voice')
  return join(dir, 'whatsapp.db')
}

interface IdentityFile {
  version: 1
  /** lid digits → phone digits */
  pairs: Record<string, string>
}

export type PairSource = 'baileys' | 'baileys-live' | 'wa-voice' | 'usync' | 'file'

/** Bare user digits from any JID shape (`447…:3@s.whatsapp.net`, `150…@lid`, `+447…`). */
export function digitsOf(jid: string | null | undefined): string | null {
  if (!jid) return null
  const user = jid.split(':')[0]!.split('@')[0]!.replace(/^\+/, '')
  return /^\d{5,}$/.test(user) ? user : null
}

const lidToPn = new Map<string, string>()
const pnToLid = new Map<string, string>()
let loaded = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

function save(): void {
  if (saveTimer) return
  // History sync hands over hundreds of pairs at once; one write per burst.
  saveTimer = setTimeout(() => {
    saveTimer = null
    const file = identityFile()
    const data: IdentityFile = { version: 1, pairs: Object.fromEntries([...lidToPn].sort()) }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 1))
      renameSync(tmp, file)
    } catch (err) {
      console.error('[al/wa-identity] save failed:', (err as Error)?.message)
    }
  }, 500)
}

/** Record one pair. Returns true when the map changed. */
export function learnPair(lid: string | null | undefined, pn: string | null | undefined, source: PairSource): boolean {
  const l = digitsOf(lid)
  const p = digitsOf(pn)
  if (!l || !p || l === p) return false
  if (lidToPn.get(l) === p) return false
  // A lid is bound to one phone; a phone may have been re-registered onto a new
  // lid, so the newest pair wins on both sides.
  const oldPn = lidToPn.get(l)
  if (oldPn && pnToLid.get(oldPn) === l) pnToLid.delete(oldPn)
  const oldLid = pnToLid.get(p)
  if (oldLid && lidToPn.get(oldLid) === p) lidToPn.delete(oldLid)
  lidToPn.set(l, p)
  pnToLid.set(p, l)
  if (loaded) {
    console.log(`[al/wa-identity] learned ${l}@lid ↔ ${p} (${source})`)
    save()
  }
  return true
}

export function pnForLid(lid: string): string | null {
  const l = digitsOf(lid)
  return l ? lidToPn.get(l) ?? null : null
}

export function lidForPn(pn: string): string | null {
  const p = digitsOf(pn)
  return p ? pnToLid.get(p) ?? null : null
}

/** The contact's OTHER identifier (digits): phone for a lid, lid for a phone.
 *  Checks the in-memory map, then the two on-disk stores for exactly this id
 *  (two small reads + one indexed query), so a pair either client learned
 *  since boot is found without a rescan. */
export function alternateFor(id: string): string | null {
  const d = digitsOf(id)
  if (!d) return null
  const hit = lidToPn.get(d) ?? pnToLid.get(d)
  if (hit || !loaded) return hit ?? null
  probeBaileys(d)
  probeWaVoice(d)
  return lidToPn.get(d) ?? pnToLid.get(d) ?? null
}

/** Every identifier the map ties to `id`, including itself: [id, alternate]. */
export function identityGroup(id: string): string[] {
  const d = digitsOf(id)
  if (!d) return []
  const alt = alternateFor(d)
  return alt ? [d, alt] : [d]
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function readJsonString(path: string): string | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** Baileys keeps `lid-mapping-<pn>.json` (→ lid) and `lid-mapping-<lid>_reverse.json` (→ pn). */
function probeBaileys(d: string, dir = AUTH_WHATSAPP_DIR): void {
  const lid = readJsonString(join(dir, `lid-mapping-${d}.json`))
  if (lid) learnPair(lid, d, 'baileys')
  const pn = readJsonString(join(dir, `lid-mapping-${d}_reverse.json`))
  if (pn) learnPair(d, pn, 'baileys')
}

/** Read every pair Baileys has on disk. Returns how many were new. */
export function seedFromBaileys(dir = AUTH_WHATSAPP_DIR): number {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return 0
  }
  let added = 0
  for (const f of files) {
    const m = /^lid-mapping-(\d+)_reverse\.json$/.exec(f)
    if (!m) continue
    const pn = readJsonString(join(dir, f))
    if (pn && learnPair(m[1]!, pn, 'baileys')) added++
  }
  return added
}

let voiceDb: DatabaseSync | null = null

/** Kept open once it opens; a store that is not there yet (wa-voice unpaired
 *  at hub boot) is looked for again on every probe. */
function openVoiceDb(): DatabaseSync | null {
  if (voiceDb) return voiceDb
  const path = waVoiceDb()
  if (!existsSync(path)) return null
  try {
    voiceDb = new DatabaseSync(path, { readOnly: true })
  } catch (err) {
    console.error('[al/wa-identity] wa-voice store unreadable:', (err as Error)?.message)
  }
  return voiceDb
}

function dropVoiceDb(): void {
  try { voiceDb?.close() } catch { /* ignore */ }
  voiceDb = null
}

function rowsToPairs(rows: unknown[]): number {
  let added = 0
  for (const r of rows as Array<{ lid?: unknown; phone_number?: unknown }>) {
    if (learnPair(String(r.lid ?? ''), String(r.phone_number ?? ''), 'wa-voice')) added++
  }
  return added
}

function probeWaVoice(d: string): void {
  const db = openVoiceDb()
  if (!db) return
  try {
    rowsToPairs(db.prepare('SELECT lid, phone_number FROM lid_pn_mapping WHERE lid = ? OR phone_number = ?').all(d, d))
  } catch (err) {
    console.error('[al/wa-identity] wa-voice probe failed:', (err as Error)?.message)
    dropVoiceDb()
  }
}

/** Read every pair wa-voice has learned (history sync, usync, peer messages). */
export function seedFromWaVoice(): number {
  const db = openVoiceDb()
  if (!db) return 0
  try {
    return rowsToPairs(db.prepare('SELECT lid, phone_number FROM lid_pn_mapping').all())
  } catch (err) {
    console.error('[al/wa-identity] wa-voice read failed:', (err as Error)?.message)
    dropVoiceDb()
    return 0
  }
}

/** Load the persisted map, then fold in whatever both clients hold on disk. */
export function loadIdentityMap(): { persisted: number; baileys: number; waVoice: number } {
  let persisted = 0
  try {
    if (existsSync(identityFile())) {
      const parsed = JSON.parse(readFileSync(identityFile(), 'utf-8')) as IdentityFile
      if (parsed.version === 1 && parsed.pairs) {
        for (const [lid, pn] of Object.entries(parsed.pairs)) if (learnPair(lid, pn, 'file')) persisted++
      }
    }
  } catch (err) {
    console.error('[al/wa-identity] load failed:', (err as Error)?.message)
  }
  const baileys = seedFromBaileys()
  const waVoice = seedFromWaVoice()
  loaded = true
  if (baileys + waVoice > 0) save()
  console.log(`[al/wa-identity] ${lidToPn.size} lid↔phone pair(s) (${persisted} persisted, +${baileys} baileys, +${waVoice} wa-voice)`)
  return { persisted, baileys, waVoice }
}

export function identityStats(): { pairs: number } {
  return { pairs: lidToPn.size }
}

/** Test seam: forget everything, including the cached wa-voice handle. */
export function resetIdentityMap(): void {
  lidToPn.clear()
  pnToLid.clear()
  loaded = false
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  dropVoiceDb()
}

// ---------------------------------------------------------------------------
// Remote lookup (Baileys' USync) — for a caller neither store has seen
// ---------------------------------------------------------------------------

export type RemoteLookup = (id: string) => Promise<{ lid?: string | null; pn?: string | null } | null>
let remoteLookup: RemoteLookup | null = null

/** Installed by the Baileys wrapper once its socket is up. */
export function setRemoteLookup(fn: RemoteLookup | null): void {
  remoteLookup = fn
}

/** `alternateFor`, then ask WhatsApp itself when both stores miss. Async, so
 *  only the paths with time to spare (ring time, an inbound message) use it. */
export async function discoverAlternate(id: string): Promise<string | null> {
  const local = alternateFor(id)
  if (local || !remoteLookup) return local
  const d = digitsOf(id)
  if (!d) return null
  try {
    const found = await remoteLookup(d)
    if (found?.lid && found.pn) learnPair(found.lid, found.pn, 'usync')
  } catch (err) {
    console.error('[al/wa-identity] remote lookup failed:', (err as Error)?.message)
  }
  return lidToPn.get(d) ?? pnToLid.get(d) ?? null
}
