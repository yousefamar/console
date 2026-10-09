// ============================================================================
// More than one Claude Max login — spill to a SECOND subscription before
// spilling to pay-per-token Bedrock.
//
// Why: on 8 Oct 2026 00:13 BST the plan's WEEKLY window hit 100 % (a genuine
// `seven_day` rejection, confirmed against the usage ledger and a real-login
// probe) three days before its reset, so the whole fleet sat on metered
// Bedrock for 74 h — $6–9k modelled at list price. A second Max subscription
// is ~$200/mo. Allowance exhaustion is now the recurring cost driver, so the
// lever is "use another subscription", not failover tuning.
//
// The unit of a login is its CONFIG DIR, not a credentials file. Each `claude`
// process refreshes its own OAuth token and rewrites `.credentials.json` in
// place, so every login must own the file it rewrites: copying credentials
// around is what killed the fleet on 7 Oct (a refresh in a copy rotated the
// shared refresh token and revoked the original). Hence one dir per login,
// holding ONLY that login's `.credentials.json` as a real file.
//
// Everything else a session needs is shared back to the canonical `~/.claude`,
// so a session behaves identically whichever login it spawns under:
//   - DIRECTORIES are symlinked (`projects`, `shell-snapshots`, …). This is
//     what keeps `--resume` working and auto-memory in one place: transcripts
//     live at `<configdir>/projects/<name>/<uuid>.jsonl`, so without the link a
//     login switch would orphan every session's history and memory.
//   - FILES are COPIED, never symlinked: the CLI rewrites files atomically
//     (tmp + rename), and a rename replaces a symlink with a real file instead
//     of writing through it — the link would silently break on first write.
//     `settings.json` is re-copied on every backend switch (auth-backend.ts
//     writes all login dirs) so a login can never be left on a stale backend.
//   - `.credentials.json` is NEVER copied or linked, in either direction.
//
// Inert until configured: with no registry file (or one login in it) the
// active dir IS `~/.claude` and every path through here behaves exactly as it
// did before. Registering a second login is what turns the machinery on.
// ============================================================================

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, lstatSync, symlinkSync, unlinkSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** The login every single-subscription install already uses. */
export const CANONICAL_NAME = 'default'

export function canonicalDir(): string {
  return join(homedir(), '.claude')
}

export interface MaxLogin {
  name: string
  dir: string
  addedAt: number
  /** Set when a plan-wide window rejected this login; cleared once it passes. */
  exhaustedUntil?: number | null
  /** Why it was last marked exhausted — for the CLI's listing. */
  exhaustedBy?: string | null
}

export interface LoginRegistryState {
  active: string
  logins: MaxLogin[]
}

/** Shared by SYMLINK — directories only (see the header: links survive the
 *  CLI's atomic file rewrites, a symlinked file does not). `projects` carries
 *  transcripts and auto-memory and is the one that makes resume work. */
export const SHARED_DIRS = [
  'projects', 'shell-snapshots', 'session-env', 'sessions', 'todos', 'plans',
  'tasks', 'teams', 'skills', 'plugins', 'file-history', 'paste-cache', 'cache',
  'state', 'statsig', 'downloads',
] as const

/** Shared by COPY — files the CLI may rewrite in place. `.credentials.json` is
 *  deliberately absent: it is the one thing a login owns privately. */
export const SHARED_FILES = ['settings.json', 'settings.local.json', '.mcp.json'] as const

/** Every env key a backend preset manages (auth-backend.ts imports this; the
 *  list lives here because this file owns each login dir's settings.json). */
export const MANAGED_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const

/** Pure: the state a registry file's contents mean, with the implicit
 *  single-login default applied. Unknown/renamed actives fall back to the
 *  canonical login rather than leaving the fleet pointing at nothing. */
export function normaliseRegistry(raw: unknown): LoginRegistryState {
  const fallback: LoginRegistryState = { active: CANONICAL_NAME, logins: [{ name: CANONICAL_NAME, dir: canonicalDir(), addedAt: 0 }] }
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Partial<LoginRegistryState>
  const logins = (Array.isArray(r.logins) ? r.logins : [])
    .filter((l): l is MaxLogin => !!l && typeof l.name === 'string' && typeof l.dir === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(l.name))
  if (logins.length === 0) return fallback
  if (!logins.some((l) => l.name === CANONICAL_NAME)) logins.unshift({ name: CANONICAL_NAME, dir: canonicalDir(), addedAt: 0 })
  const active = logins.some((l) => l.name === r.active) ? r.active! : CANONICAL_NAME
  return { active, logins }
}

/** Pure: which login to rotate to when `active` can no longer serve. Picks the
 *  first other login whose exhaustion mark has expired; null when there is
 *  nowhere to go (the single-subscription case, or every login is spent) and
 *  the caller should spill to Bedrock as before. */
export function pickRotation(state: LoginRegistryState, now: number): MaxLogin | null {
  return state.logins.find((l) => l.name !== state.active && !(l.exhaustedUntil && l.exhaustedUntil > now)) ?? null
}

/** Create a login's config dir: shared directories linked, shared files
 *  copied, credentials left alone. Idempotent — safe to re-run at every boot,
 *  which is what repairs a link the CLI replaced. Returns what it did. */
export function ensureLoginDir(dir: string, canonical = canonicalDir()): { linked: string[]; copied: string[] } {
  const linked: string[] = []
  const copied: string[] = []
  mkdirSync(dir, { recursive: true })
  if (dir === canonical) return { linked, copied }
  for (const entry of SHARED_DIRS) {
    const target = join(canonical, entry)
    if (!existsSync(target)) continue
    const link = join(dir, entry)
    try {
      const st = lstatSync(link, { throwIfNoEntry: false })
      if (st?.isSymbolicLink()) continue // already ours
      if (st) continue                   // a real dir the CLI made: leave it, never clobber data
      symlinkSync(target, link)
      linked.push(entry)
    } catch { /* a dir we cannot link is not worth failing a boot over */ }
  }
  for (const entry of SHARED_FILES) {
    const src = join(canonical, entry)
    if (!existsSync(src)) continue
    const dst = join(dir, entry)
    try {
      const st = lstatSync(dst, { throwIfNoEntry: false })
      if (st?.isSymbolicLink()) unlinkSync(dst) // a link here would break on the CLI's next write
      copyFileSync(src, dst)
      copied.push(entry)
    } catch { /* ditto */ }
  }
  if (!existsSync(join(dir, '.credentials.json'))) stripManagedEnv(join(dir, 'settings.json'))
  return { linked, copied }
}

/** Remove the backend preset's env from a settings.json. A dir with no
 *  credentials can do exactly one thing — `claude auth login` — and that has to
 *  reach Anthropic, so it must not inherit a spill. Provisioning copies the
 *  canonical settings.json verbatim, and while the fleet is spilled that file
 *  carries `CLAUDE_CODE_USE_BEDROCK=1`: a login added mid-spill therefore talked
 *  to Bedrock and never offered the OAuth flow at all (9 Oct 2026, the second
 *  Max login). auth-backend.ts puts the right env back on the next switch, by
 *  which point the login has credentials. */
function stripManagedEnv(path: string): void {
  try {
    const raw = readFileSync(path, 'utf-8')
    const json = JSON.parse(raw)
    const env = json?.env
    if (!env || typeof env !== 'object') return
    let changed = false
    for (const key of MANAGED_ENV_KEYS) {
      if (key in env) { delete env[key]; changed = true }
    }
    if (!changed) return
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`)
    renameSync(tmp, path)
  } catch { /* a settings file we cannot rewrite is not worth failing a boot over */ }
}

export interface LoginRegistryDeps {
  log?: (msg: string) => void
  now?: () => number
}

/** The registered Max logins and which one the fleet currently spawns under. */
export class MaxLoginRegistry {
  private state: LoginRegistryState
  private readonly now: () => number

  constructor(private readonly path: string, private readonly deps: LoginRegistryDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.state = this.load()
  }

  getState(): LoginRegistryState {
    return { active: this.state.active, logins: this.state.logins.map((l) => ({ ...l })) }
  }

  /** True once a SECOND login exists — i.e. rotation is possible at all. */
  isMulti(): boolean {
    return this.state.logins.length > 1
  }

  get(name: string): MaxLogin | null {
    return this.state.logins.find((l) => l.name === name) ?? null
  }

  active(): MaxLogin {
    return this.get(this.state.active) ?? { name: CANONICAL_NAME, dir: canonicalDir(), addedAt: 0 }
  }

  /** The config dir every session should spawn under. */
  activeDir(): string {
    return this.active().dir
  }

  /** Every registered dir — auth-backend.ts keeps settings.json in step across
   *  all of them, so a rotation never lands a login on the wrong backend. */
  dirs(): string[] {
    const seen = new Set<string>()
    for (const l of this.state.logins) seen.add(l.dir)
    seen.add(canonicalDir())
    return [...seen]
  }

  /** Register a login. The dir is provisioned but NOT logged in — that needs a
   *  real `claude auth login` under it, which only Yousef can do. */
  add(name: string, dir?: string): MaxLogin {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(name)) throw new Error(`bad login name '${name}' (use [a-z0-9-], max 32)`)
    if (this.get(name)) throw new Error(`login '${name}' already exists`)
    const resolved = dir ?? join(homedir(), '.claude-logins', name)
    const login: MaxLogin = { name, dir: resolved, addedAt: this.now() }
    ensureLoginDir(resolved)
    this.state.logins.push(login)
    this.save()
    return { ...login }
  }

  remove(name: string): void {
    if (name === CANONICAL_NAME) throw new Error(`cannot remove the '${CANONICAL_NAME}' login`)
    if (!this.get(name)) throw new Error(`no login '${name}'`)
    if (this.state.active === name) this.state.active = CANONICAL_NAME
    this.state.logins = this.state.logins.filter((l) => l.name !== name)
    this.save()
  }

  /** Point the fleet at a login. Caller owns respawning sessions. */
  setActive(name: string): MaxLogin {
    const login = this.get(name)
    if (!login) throw new Error(`no login '${name}'`)
    ensureLoginDir(login.dir)
    this.state.active = name
    this.save()
    this.deps.log?.(`[logins] active login is now '${name}' (${login.dir})`)
    return { ...login }
  }

  /** A plan-wide window rejected this login: do not rotate back to it until
   *  the window resets. */
  markExhausted(name: string, until: number | null, by?: string): void {
    const login = this.get(name)
    if (!login) return
    login.exhaustedUntil = until
    login.exhaustedBy = by ?? null
    this.save()
  }

  clearExhausted(name: string): void {
    const login = this.get(name)
    if (!login || (login.exhaustedUntil == null && login.exhaustedBy == null)) return
    login.exhaustedUntil = null
    login.exhaustedBy = null
    this.save()
  }

  /** The login to move to, or null to spill to Bedrock as before. */
  pickRotation(): MaxLogin | null {
    const next = pickRotation(this.state, this.now())
    return next ? { ...next } : null
  }

  /** Re-link/re-copy every registered dir. Cheap, and repairs a shared entry
   *  the CLI replaced with a real file since the last boot. */
  ensureAll(): void {
    for (const l of this.state.logins) {
      if (l.dir === canonicalDir()) continue
      const { linked, copied } = ensureLoginDir(l.dir)
      if (linked.length || copied.length) this.deps.log?.(`[logins] ${l.name}: linked ${linked.join(', ') || 'nothing'}; copied ${copied.join(', ') || 'nothing'}`)
    }
  }

  private load(): LoginRegistryState {
    try {
      return normaliseRegistry(JSON.parse(readFileSync(this.path, 'utf-8')))
    } catch {
      return normaliseRegistry(null)
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.path)
    } catch (e) {
      this.deps.log?.(`[logins] save failed: ${(e as Error).message}`)
    }
  }
}

/** Process-wide handle. `index.ts` sets it at boot; the spawn path and
 *  auth-backend read it. Unset (tests, scripts) means the single-login world:
 *  the canonical dir, exactly as before. */
let current: MaxLoginRegistry | null = null

export function setLoginRegistry(reg: MaxLoginRegistry | null): void {
  current = reg
}

export function loginRegistry(): MaxLoginRegistry | null {
  return current
}

/** The config dir sessions spawn under right now. */
export function activeLoginDir(): string {
  return current?.activeDir() ?? canonicalDir()
}

/** Every config dir whose settings.json must track the active backend. */
export function loginDirs(): string[] {
  return current?.dirs() ?? [canonicalDir()]
}
