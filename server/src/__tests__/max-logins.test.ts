import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MaxLoginRegistry, normaliseRegistry, pickRotation, ensureLoginDir, canonicalDir,
  activeLoginDir, setLoginRegistry, loginDirs, CANONICAL_NAME, SHARED_FILES,
} from '../max-logins.js'
import { maxLoginEnv } from '../max-login.js'

const T0 = 1_800_000_000_000

describe('normaliseRegistry', () => {
  it('nothing on disk means the single-subscription world', () => {
    for (const raw of [null, undefined, 'junk', {}, { logins: [] }]) {
      const s = normaliseRegistry(raw)
      expect(s.active).toBe(CANONICAL_NAME)
      expect(s.logins).toEqual([{ name: CANONICAL_NAME, dir: canonicalDir(), addedAt: 0 }])
    }
  })

  it('drops malformed entries and always keeps a canonical login', () => {
    const s = normaliseRegistry({ active: 'second', logins: [{ name: 'second', dir: '/tmp/second', addedAt: 1 }, { name: 'no dir' }, null] })
    expect(s.logins.map((l) => l.name)).toEqual([CANONICAL_NAME, 'second'])
    expect(s.active).toBe('second')
  })

  it('an active that no longer exists falls back to the canonical login', () => {
    const s = normaliseRegistry({ active: 'deleted', logins: [{ name: CANONICAL_NAME, dir: canonicalDir(), addedAt: 0 }] })
    expect(s.active).toBe(CANONICAL_NAME)
  })
})

describe('pickRotation', () => {
  const l = (name: string, exhaustedUntil?: number) => ({ name, dir: `/tmp/${name}`, addedAt: 0, exhaustedUntil })

  it('one subscription has nowhere to go — the caller spills to Bedrock as before', () => {
    expect(pickRotation({ active: CANONICAL_NAME, logins: [l(CANONICAL_NAME)] }, T0)).toBeNull()
  })

  it('picks another login, never the active one', () => {
    const s = { active: 'a', logins: [l('a'), l('b')] }
    expect(pickRotation(s, T0)?.name).toBe('b')
  })

  it('skips a login whose window has not reset yet, takes one whose mark expired', () => {
    expect(pickRotation({ active: 'a', logins: [l('a'), l('b', T0 + 60_000)] }, T0)).toBeNull()
    expect(pickRotation({ active: 'a', logins: [l('a'), l('b', T0 - 1)] }, T0)?.name).toBe('b')
  })
})

describe('ensureLoginDir', () => {
  let canonical: string
  let login: string

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'logins-'))
    canonical = join(root, 'canonical')
    login = join(root, 'second')
    mkdirSync(join(canonical, 'projects', 'proj-a'), { recursive: true })
    writeFileSync(join(canonical, 'projects', 'proj-a', 'a.jsonl'), '{}\n')
    mkdirSync(join(canonical, 'todos'), { recursive: true })
    writeFileSync(join(canonical, 'settings.json'), '{"env":{}}')
    writeFileSync(join(canonical, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"real"}}')
  })
  afterEach(() => rmSync(join(canonical, '..'), { recursive: true, force: true }))

  it('shares directories by symlink, so transcripts and memory stay in one place', () => {
    const { linked } = ensureLoginDir(login, canonical)
    expect(linked).toContain('projects')
    expect(lstatSync(join(login, 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(login, 'projects'))).toBe(join(canonical, 'projects'))
    // The point of the link: a transcript written under the login resolves to
    // the canonical tree, which is what keeps `--resume` working.
    expect(readFileSync(join(login, 'projects', 'proj-a', 'a.jsonl'), 'utf-8')).toBe('{}\n')
  })

  it('shares files by COPY — a symlinked file would break on the CLI\'s next atomic write', () => {
    const { copied } = ensureLoginDir(login, canonical)
    expect(copied).toContain('settings.json')
    expect(lstatSync(join(login, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(login, 'settings.json'), 'utf-8')).toBe('{"env":{}}')
  })

  it('NEVER brings credentials across — a shared refresh token revokes the original', () => {
    ensureLoginDir(login, canonical)
    expect(existsSync(join(login, '.credentials.json'))).toBe(false)
    expect(SHARED_FILES as readonly string[]).not.toContain('.credentials.json')
  })

  it('is idempotent, and repairs a shared file the CLI replaced with a symlink', () => {
    ensureLoginDir(login, canonical)
    const again = ensureLoginDir(login, canonical)
    expect(again.linked).toEqual([]) // links already ours
    rmSync(join(login, 'settings.json'))
    symlinkSync(join(canonical, 'settings.json'), join(login, 'settings.json'))
    ensureLoginDir(login, canonical)
    expect(lstatSync(join(login, 'settings.json')).isSymbolicLink()).toBe(false)
  })

  it('never clobbers a real directory the CLI already wrote into', () => {
    mkdirSync(join(login, 'projects', 'own'), { recursive: true })
    writeFileSync(join(login, 'projects', 'own', 'keep.jsonl'), 'mine\n')
    ensureLoginDir(login, canonical)
    expect(lstatSync(join(login, 'projects')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(login, 'projects', 'own', 'keep.jsonl'), 'utf-8')).toBe('mine\n')
  })

  it('the canonical dir is left exactly as it is', () => {
    expect(ensureLoginDir(canonical, canonical)).toEqual({ linked: [], copied: [] })
  })
})

describe('MaxLoginRegistry', () => {
  let dir: string
  let path: string
  const make = () => new MaxLoginRegistry(path, { now: () => T0 })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'login-reg-'))
    path = join(dir, 'max-logins.json')
  })
  afterEach(() => { setLoginRegistry(null); rmSync(dir, { recursive: true, force: true }) })

  it('with no file it is the canonical login and NOT multi — nothing changes behaviour', () => {
    const r = make()
    expect(r.isMulti()).toBe(false)
    expect(r.activeDir()).toBe(canonicalDir())
    expect(r.pickRotation()).toBeNull()
    expect(r.dirs()).toEqual([canonicalDir()])
    expect(existsSync(path)).toBe(false) // reading never writes
  })

  it('a second login turns rotation on and survives a reload', () => {
    const r = make()
    const added = r.add('second', join(dir, 'second'))
    expect(added.dir).toBe(join(dir, 'second'))
    expect(existsSync(join(dir, 'second'))).toBe(true)
    expect(r.isMulti()).toBe(true)
    expect(r.pickRotation()?.name).toBe('second')
    expect(new MaxLoginRegistry(path, {}).getState().logins.map((l) => l.name)).toEqual([CANONICAL_NAME, 'second'])
  })

  it('setActive moves the spawn dir; dirs() always includes the canonical one', () => {
    const r = make()
    r.add('second', join(dir, 'second'))
    r.setActive('second')
    expect(r.activeDir()).toBe(join(dir, 'second'))
    expect(r.dirs()).toContain(canonicalDir())
    expect(r.dirs()).toContain(join(dir, 'second'))
    expect(new MaxLoginRegistry(path, {}).activeDir()).toBe(join(dir, 'second'))
  })

  it('an exhausted login is not a rotation target until its window resets', () => {
    const r = make()
    r.add('second', join(dir, 'second'))
    r.markExhausted('second', T0 + 60_000, 'seven_day')
    expect(r.pickRotation()).toBeNull()
    r.clearExhausted('second')
    expect(r.pickRotation()?.name).toBe('second')
  })

  it('rejects junk names, duplicates, and removing the canonical login', () => {
    const r = make()
    expect(() => r.add('has space')).toThrow(/bad login name/)
    r.add('second', join(dir, 'second'))
    expect(() => r.add('second')).toThrow(/already exists/)
    expect(() => r.remove(CANONICAL_NAME)).toThrow(/cannot remove/)
    expect(() => r.remove('nope')).toThrow(/no login/)
  })

  it('removing the active login falls back to the canonical one', () => {
    const r = make()
    r.add('second', join(dir, 'second'))
    r.setActive('second')
    r.remove('second')
    expect(r.getState().active).toBe(CANONICAL_NAME)
    expect(r.activeDir()).toBe(canonicalDir())
  })

  it('the process-wide handle drives the spawn dir, and unset means canonical', () => {
    expect(activeLoginDir()).toBe(canonicalDir())
    expect(loginDirs()).toEqual([canonicalDir()])
    const r = make()
    r.add('second', join(dir, 'second'))
    r.setActive('second')
    setLoginRegistry(r)
    expect(activeLoginDir()).toBe(join(dir, 'second'))
    expect(loginDirs()).toContain(join(dir, 'second'))
    setLoginRegistry(null)
    expect(activeLoginDir()).toBe(canonicalDir())
  })
})

describe('the login probe', () => {
  it('can be aimed at one specific login\'s REAL dir', () => {
    const env = maxLoginEnv({ HOME: '/home/amar', ANTHROPIC_API_KEY: 'k' }, '/home/amar/.claude-logins/second')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/amar/.claude-logins/second')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined() // an API key would prove nothing about the subscription
  })

  it('without a dir it probes whatever the fleet is on, as before', () => {
    expect(maxLoginEnv({ HOME: '/home/amar' }).CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
