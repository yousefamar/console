import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// 17 Sep: `  - "16690310078559"   # his @lid identity` in users/yehia-amar.md
// never resolved — the hand-rolled parser kept the comment as part of the
// value — so the hub greeted him as a new contact and wrote yehia-amar-1.md
// twice (^rare-kiwi). The parser is now the real yaml package.

const workspace = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'al-users-'))
  process.env.AL_WORKSPACE_DIR = dir
  return dir
})

const users = await import('../al/users.js')

const file = (fm: string) => `---\n${fm}\n---\n\n## Someone\n`

describe('parseFrontmatter', () => {
  it('drops trailing # comments on list items and scalars', () => {
    const fm = users.parseFrontmatter(file(
      'whatsapp:\n  - "447700900001"\n  - "16690310078559"   # his @lid identity\nphone: "447700900001" # SIM',
    ))
    expect(fm.whatsapp).toEqual(['447700900001', '16690310078559'])
    expect(fm.phone).toBe('447700900001')
  })

  it('keeps a # inside a quoted value', () => {
    expect(users.parseFrontmatter(file('slack: "U0#1"')).slack).toBe('U0#1')
  })

  it('stringifies unquoted numeric ids without losing digits', () => {
    const fm = users.parseFrontmatter(file('whatsapp:\n  - 273898788626516\n  - 4477009000011234567'))
    expect(fm.whatsapp).toEqual(['273898788626516', '4477009000011234567'])
  })

  it('tolerates the shapes the real user files use', () => {
    const fm = users.parseFrontmatter(file(
      'beeper: "!ObWXMIptVELpeIhwliuR:beeper.local"\nemail: nic@dreamlab.bm\nallow:\n  - astera-tickets\ndeny:\nlanguage: english',
    ))
    expect(fm.beeper).toBe('!ObWXMIptVELpeIhwliuR:beeper.local')
    expect(fm.email).toBe('nic@dreamlab.bm')
    expect(fm.allow).toEqual(['astera-tickets'])
    expect(fm.deny).toBeUndefined()
    expect(fm.language).toBe('english')
  })

  it('returns {} for missing or unparseable frontmatter', () => {
    expect(users.parseFrontmatter('## no frontmatter\n')).toEqual({})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(users.parseFrontmatter(file('whatsapp: [unclosed'), 'x.md')).toEqual({})
    expect(err).toHaveBeenCalledWith(expect.stringContaining('x.md'))
    err.mockRestore()
  })
})

describe('resolveUsername through the workspace', () => {
  beforeAll(async () => {
    await mkdir(join(workspace, 'users'), { recursive: true })
    await writeFile(join(workspace, 'users', 'yehia-amar.md'), file(
      'whatsapp:\n  - "447700900002"\n  - "16690310078559"   # his @lid identity\nphone: "447700900002"   # SIM\nallow:\n  - family   # everything',
    ))
    await users.loadUsers()
  })
  afterAll(() => rm(workspace, { recursive: true, force: true }))

  it('resolves a commented list item and a commented scalar', () => {
    expect(users.resolveUsername('16690310078559@lid')).toBe('yehia-amar')
    expect(users.resolveUsername('+447700900002')).toBe('yehia-amar')
    expect(users.resolveAllow('16690310078559@lid')).toEqual(['family'])
    expect(users.identifiersFor('yehia-amar').sort()).toEqual(['16690310078559', '447700900002'])
  })

  it('does not re-create a known contact', async () => {
    const notify = vi.fn()
    users.setUserNotifier(notify)
    await users.ensureUserKnown('16690310078559@lid', 'whatsapp', 'Yehia Amar')
    expect(notify).not.toHaveBeenCalled()
  })

  // 24 Sep (^teal-tern): "Message Yassin" — Yasin had no note, and Yasmina's
  // note lacked her @lid; both edits were invisible to the running hub because
  // the map was built once at boot.
  it('sees an identifier added to a note after boot once refreshed', async () => {
    await writeFile(join(workspace, 'users', 'yehia-amar.md'), file(
      'whatsapp:\n  - "447700900002"\n  - "16690310078559"\n  - "998877665544332"\nphone: "447700900002"\nallow:\n  - family',
    ))
    expect(users.identifiersFor('yehia-amar')).not.toContain('998877665544332')
    await users.refreshUsers()
    expect(users.identifiersFor('yehia-amar')).toContain('998877665544332')
    expect(users.resolveUsername('998877665544332@lid')).toBe('yehia-amar')
  })

  it('does not auto-create a duplicate for a contact whose note was written by hand since boot', async () => {
    await writeFile(join(workspace, 'users', 'yasin-amar.md'), file('whatsapp: "103393284649109"'))
    const notify = vi.fn()
    users.setUserNotifier(notify)
    await users.ensureUserKnown('103393284649109@lid', 'whatsapp', 'Yasin Amar')
    expect(notify).not.toHaveBeenCalled()
    expect(users.resolveUsername('103393284649109@lid')).toBe('yasin-amar')
    expect(users.identifiersFor('yasin-amar')).toEqual(['103393284649109'])
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(workspace, 'users'))).sort()).toEqual(['yasin-amar.md', 'yehia-amar.md'])
  })
})
