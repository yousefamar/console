import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 30 Sept 2026: Rebaz's note (from a Beeper room) listed only his @lid; he
// rang AL from his phone JID and the hub saw user=None — while Baileys' store
// and wa-voice's SQLite had both held the pair since the 28th (^calm-ram).

const dirs = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'wa-identity-'))
  process.env.AL_WORKSPACE_DIR = join(root, 'workspace')
  process.env.CONSOLE_AUTH_WHATSAPP_DIR = join(root, 'auth_whatsapp')
  process.env.WA_VOICE_STORE_DIR = join(root, 'wa-voice')
  process.env.CONSOLE_WA_IDENTITY_FILE = join(root, 'wa-identity.json')
  process.env.CONSOLE_WA_HISTORY_FILE = join(root, 'wa-history.json')
  return { root, workspace: join(root, 'workspace'), baileys: join(root, 'auth_whatsapp'), voice: join(root, 'wa-voice'), file: join(root, 'wa-identity.json') }
})

const identity = await import('../al/wa-identity.js')
const users = await import('../al/users.js')
const voice = await import('../al/voice.js')

const LID = '150938169962699'
const PN = '447848913226'
const note = (fm: string, body = '## Someone\n') => `---\n${fm}\n---\n\n${body}`
const usersDir = join(dirs.workspace, 'users')
const settle = () => new Promise((r) => setTimeout(r, 50))

async function baileysPair(lid: string, pn: string): Promise<void> {
  await mkdir(dirs.baileys, { recursive: true })
  await writeFile(join(dirs.baileys, `lid-mapping-${pn}.json`), JSON.stringify(lid))
  await writeFile(join(dirs.baileys, `lid-mapping-${lid}_reverse.json`), JSON.stringify(pn))
}

function voicePairs(rows: Array<[string, string]>): void {
  const db = new DatabaseSync(join(dirs.voice, 'whatsapp.db'))
  db.exec('CREATE TABLE IF NOT EXISTS lid_pn_mapping (lid TEXT NOT NULL, phone_number TEXT NOT NULL, created_at BIGINT, learning_source TEXT, updated_at BIGINT, device_id INTEGER, PRIMARY KEY (lid, device_id))')
  const ins = db.prepare('INSERT OR REPLACE INTO lid_pn_mapping VALUES (?, ?, 0, ?, 0, 1)')
  for (const [lid, pn] of rows) ins.run(lid, pn, 'other')
  db.close()
}

beforeEach(async () => {
  identity.resetIdentityMap()
  identity.setRemoteLookup(null)
  await rm(dirs.root, { recursive: true, force: true })
  await mkdir(usersDir, { recursive: true })
  await mkdir(dirs.baileys, { recursive: true })
  await mkdir(dirs.voice, { recursive: true })
})
afterAll(() => rm(dirs.root, { recursive: true, force: true }))

describe('wa-identity map', () => {
  it('reads digits out of every JID shape', () => {
    expect(identity.digitsOf(`${PN}@s.whatsapp.net`)).toBe(PN)
    expect(identity.digitsOf(`${PN}:3@s.whatsapp.net`)).toBe(PN)
    expect(identity.digitsOf(`${LID}@lid`)).toBe(LID)
    expect(identity.digitsOf(`+${PN}`)).toBe(PN)
    expect(identity.digitsOf('U0#1')).toBeNull()
    expect(identity.digitsOf('')).toBeNull()
  })

  it('answers both directions and lets a re-registered phone move to a new lid', () => {
    expect(identity.learnPair(`${LID}@lid`, `${PN}@s.whatsapp.net`, 'baileys-live')).toBe(true)
    expect(identity.learnPair(LID, PN, 'baileys-live')).toBe(false)
    expect(identity.pnForLid(`${LID}@lid`)).toBe(PN)
    expect(identity.lidForPn(PN)).toBe(LID)
    expect(identity.alternateFor(LID)).toBe(PN)
    expect(identity.alternateFor(PN)).toBe(LID)
    expect(identity.identityGroup(`${PN}@s.whatsapp.net`)).toEqual([PN, LID])
    identity.learnPair('999888777666555', PN, 'usync')
    expect(identity.lidForPn(PN)).toBe('999888777666555')
    expect(identity.pnForLid(LID)).toBeNull()
  })

  it('seeds from Baileys files and wa-voice SQLite, persists the union, and reloads it', async () => {
    await baileysPair(LID, PN)
    voicePairs([[LID, PN], ['34154016194786', '447897073727']])
    vi.useFakeTimers()
    try {
      expect(identity.loadIdentityMap()).toEqual({ persisted: 0, baileys: 1, waVoice: 1 })
      expect(identity.identityStats().pairs).toBe(2)
      await vi.advanceTimersByTimeAsync(600)
    } finally {
      vi.useRealTimers()
    }
    expect(existsSync(dirs.file)).toBe(true)
    expect(JSON.parse(await readFile(dirs.file, 'utf-8'))).toEqual({ version: 1, pairs: { [LID]: PN, '34154016194786': '447897073727' } })
    // Baileys wiped its store on logout: the pairs survive in the hub's file.
    identity.resetIdentityMap()
    await rm(dirs.baileys, { recursive: true, force: true })
    await rm(dirs.voice, { recursive: true, force: true })
    expect(identity.loadIdentityMap()).toEqual({ persisted: 2, baileys: 0, waVoice: 0 })
    expect(identity.pnForLid(LID)).toBe(PN)
  })

  it('finds a pair either client learned since boot without a rescan', async () => {
    identity.loadIdentityMap()
    expect(identity.alternateFor(PN)).toBeNull()
    await baileysPair(LID, PN)
    expect(identity.alternateFor(PN)).toBe(LID)
    voicePairs([['252827561627836', '447700900123']])
    expect(identity.alternateFor('447700900123@s.whatsapp.net')).toBe('252827561627836')
  })

  it('asks the remote lookup only when both stores miss, and keeps the answer', async () => {
    identity.loadIdentityMap()
    const remote = vi.fn(async (d: string) => (d === PN ? { lid: LID, pn: PN } : null))
    identity.setRemoteLookup(remote)
    expect(await identity.discoverAlternate(`${PN}@s.whatsapp.net`)).toBe(LID)
    expect(await identity.discoverAlternate(PN)).toBe(LID)
    expect(remote).toHaveBeenCalledTimes(1)
    expect(await identity.discoverAlternate('447700900999')).toBeNull()
  })
})

describe('users resolver through the lid↔phone map', () => {
  it('resolves a phone JID to a note that lists only the @lid, and writes the phone into the note', async () => {
    await baileysPair(LID, PN)
    await writeFile(join(usersDir, 'rebaz-has.md'), note(`whatsapp:\n  - "${LID}"\ncalls: true\nallow:\n  - calls`, '## Rebaz Has\n'))
    identity.loadIdentityMap()
    await users.loadUsers()
    expect(users.resolveUsername(`${PN}@s.whatsapp.net`)).toBe('rebaz-has')
    expect(users.resolveAllow(`${PN}@s.whatsapp.net`)).toEqual(['calls'])
    expect(users.identifiersFor('rebaz-has').sort()).toEqual([LID, PN])
    await settle()
    const written = await readFile(join(usersDir, 'rebaz-has.md'), 'utf-8')
    expect(written).toBe(note(`whatsapp:\n  - "${LID}"\n  - "${PN}"\ncalls: true\nallow:\n  - calls`, '## Rebaz Has\n'))
    expect(users.parseFrontmatter(written).whatsapp).toEqual([LID, PN])
  })

  it('adopts a pair learned after boot on first use, without a duplicate note', async () => {
    await writeFile(join(usersDir, 'rebaz-has.md'), note(`whatsapp: "${LID}"`))
    identity.loadIdentityMap()
    await users.loadUsers()
    expect(users.resolveUsername(`${PN}@s.whatsapp.net`)).toBeNull()
    identity.learnPair(LID, PN, 'baileys-live')
    const notify = vi.fn()
    users.setUserNotifier(notify)
    await users.ensureUserKnown(`${PN}@s.whatsapp.net`, 'whatsapp', 'Rebaz')
    expect(notify).not.toHaveBeenCalled()
    expect(users.resolveUsername(`${PN}@s.whatsapp.net`)).toBe('rebaz-has')
    await settle()
    expect((await readdir(usersDir)).sort()).toEqual(['rebaz-has.md'])
    expect(users.parseFrontmatter(await readFile(join(usersDir, 'rebaz-has.md'), 'utf-8')).whatsapp).toEqual([LID, PN])
  })

  it('answers the call and dials the slug for a lid-only note', async () => {
    await baileysPair(LID, PN)
    await writeFile(join(usersDir, 'rebaz-has.md'), note(`whatsapp:\n  - "${LID}"\ncalls: true`))
    identity.loadIdentityMap()
    await users.loadUsers()
    const caller = await voice.lookupCaller(`${PN}@s.whatsapp.net`)
    expect(caller.user).toBe('rebaz-has')
    expect(voice.answerPolicy(caller, 'in')).toEqual({ answer: true, why: 'known user rebaz-has' })
    expect(voice.resolveCallTarget('rebaz-has')).toBe(`${PN}@s.whatsapp.net`)
    expect(voice.resolveCallTarget(`${LID}@lid`)).toBe(`${PN}@s.whatsapp.net`)
    expect(voice.resolveCallTarget('142245139378326@lid')).toBe('142245139378326@lid')
  })

  it('sees a phone added to a note by hand at ring time, with no restart', async () => {
    await writeFile(join(usersDir, 'rebaz-has.md'), note(`whatsapp: "${LID}"`))
    identity.loadIdentityMap()
    await users.loadUsers()
    expect((await voice.lookupCaller(`${PN}@s.whatsapp.net`)).user).toBeNull()
    await writeFile(join(usersDir, 'rebaz-has.md'), note(`whatsapp:\n  - "${LID}"\n  - "${PN}"`))
    expect((await voice.lookupCaller(`${PN}@s.whatsapp.net`)).user).toBe('rebaz-has')
  })

  it('a new contact whose pair is known gets both ids in the auto-created note', async () => {
    await baileysPair('123456789012345', '447700900555')
    identity.loadIdentityMap()
    await users.loadUsers()
    users.setUserNotifier(() => {})
    await users.ensureUserKnown('447700900555@s.whatsapp.net', 'whatsapp', 'New Person')
    const fm = users.parseFrontmatter(await readFile(join(usersDir, 'new-person.md'), 'utf-8'))
    expect(fm.whatsapp).toEqual(['447700900555', '123456789012345'])
    expect(users.resolveUsername('123456789012345@lid')).toBe('new-person')
  })
})

describe('withWhatsappIdentifier', () => {
  const fm = (s: string) => users.parseFrontmatter(s)
  it('appends to a list, matching its indentation', () => {
    const out = users.withWhatsappIdentifier(note('whatsapp:\n    - "1"\n    - "2"\nlanguage: english'), '3')!
    expect(out).toBe(note('whatsapp:\n    - "1"\n    - "2"\n    - "3"\nlanguage: english'))
  })
  it('promotes a scalar, keeps a flow sequence, creates a missing key', () => {
    expect(fm(users.withWhatsappIdentifier(note('whatsapp: "1"\nphone: "1"'), '2')!).whatsapp).toEqual(['1', '2'])
    expect(users.withWhatsappIdentifier(note('whatsapp: ["1", "2"]'), '3')).toBe(note('whatsapp: ["1", "2", "3"]'))
    expect(users.withWhatsappIdentifier(note('slack: U01'), '2')).toBe(note('slack: U01\nwhatsapp:\n  - "2"'))
  })
  it('leaves the body alone and refuses a no-op', () => {
    const body = '## Nica\n\nLikes cats. `code` — and a --- rule\n'
    const out = users.withWhatsappIdentifier(note('whatsapp:\n  - "1"', body), '2')!
    expect(out.endsWith(`---\n\n${body}`)).toBe(true)
    expect(users.withWhatsappIdentifier(note('whatsapp:\n  - "1"\n  - "2"'), '2')).toBeNull()
    expect(users.withWhatsappIdentifier('## no frontmatter\n', '2')).toBeNull()
  })
})
