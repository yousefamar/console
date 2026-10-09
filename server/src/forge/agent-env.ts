// What a remote `claude` needs beyond its cwd.
//
// The cwd arrives by sshfs (mounts.ts), but Claude Code also walks UP from cwd
// for CLAUDE.md and reads a pile of per-user config out of ~/.claude. On forge
// those ancestors do not exist, so a remote fork would silently run without
// Yousef's standing rules — the worst kind of difference, because nothing
// errors; the agent just behaves wrongly. So we mirror them explicitly:
//
//   ~/CLAUDE.md                  the working rules (46 KB)
//   ~/sync/brain/CLAUDE.md       the vault's conventions (24 KB)
//   ~/.claude/skills             7 MB
//   ~/.claude/plugins            59 MB
//   ~/.claude/settings.json      Bedrock wiring, with AWS_PROFILE REMOVED
//
// The settings rewrite is the important one: the desktop authenticates to
// Bedrock with `AWS_PROFILE=bedrock-amar`, a static key that must not be copied
// to a cloud box. forge uses its INSTANCE ROLE instead. Per-person cost
// attribution is unaffected — the owner tag rides the application-inference
// profile ARN in ANTHROPIC_MODEL, not the calling principal.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, renameSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ForgeConfig } from './config.js'
import { forgeExec } from './ssh.js'
import { presetEnv } from '../auth-backend.js'
import { MANAGED_ENV_KEYS, SHARED_DIRS } from '../max-logins.js'

const execFileP = promisify(execFile)

function sshEnvPath(): NodeJS.ProcessEnv {
  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const merged = [...new Set([...extra, ...(process.env.PATH ?? '').split(':')])].filter(Boolean)
  return { ...process.env, PATH: merged.join(':') }
}

async function rsyncUp(cfg: ForgeConfig, local: string, remote: string, opts: { dir?: boolean } = {}): Promise<boolean> {
  if (!existsSync(local)) return true
  const src = opts.dir ? `${local.replace(/\/$/, '')}/` : local
  return execFileP('rsync', ['-az', '--delete-after', '-e', 'ssh -o BatchMode=yes', src, `${cfg.host}:${remote}`], {
    env: sshEnvPath(), timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
  }).then(() => true).catch(() => false)
}

/** Static AWS credentials that belong to the desktop and must never reach a
 *  cloud box; forge authenticates with its instance role. */
const DESKTOP_ONLY_ENV = ['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const

/** The Bedrock wiring a forge process needs, whatever backend the FLEET is on.
 *
 *  forge has no Claude Max login and must never be given a copied one, so a
 *  forge fork can only ever run on Bedrock. Until 9 Oct 2026 it got that wiring
 *  by accident: it inherited the desktop's settings.json, which carried it only
 *  while the fleet itself was on Bedrock. The night the fleet moved to a second
 *  Max login, the next mirror shipped first-party settings and a first-party
 *  `--model`, and all 21 forge forks answered "Not logged in" for 40 minutes. */
export function remoteBedrockEnv(): Record<string, string> {
  const env = presetEnv('bedrock')
  for (const k of DESKTOP_ONLY_ENV) delete env[k]
  return env
}

/** Rewrite the desktop's settings.json for the box: static credentials out (the
 *  remote process falls through to the instance role), and `bedrockEnv`, when
 *  given, in — so the file is Bedrock-wired even if the desktop's is not. */
export function remoteSettings(json: string, bedrockEnv?: Record<string, string>): string {
  const parsed = JSON.parse(json) as { env?: Record<string, string> } & Record<string, unknown>
  if (parsed.env) {
    for (const k of DESKTOP_ONLY_ENV) delete parsed.env[k]
  }
  if (bedrockEnv) parsed.env = { ...(parsed.env ?? {}), ...bedrockEnv }
  return JSON.stringify(parsed, null, 2)
}

// ── Claude Max logins ON the box ─────────────────────────────────────────────
//
// forge can run on a Max subscription only through a login made ON forge, by
// Yousef, interactively (`CLAUDE_CONFIG_DIR=<dir> claude auth login`). Never a
// copied credentials file: a refresh in a copy rotates the shared token and
// revokes the original (7 Oct 2026). Each account gets its own dir on the box,
// holding that account's `.credentials.json` and nothing else of its own —
// transcripts, skills and plugins are SYMLINKED back to the box's `~/.claude`,
// so a fork's `--resume` finds the same file whichever account it runs under.
// Skipping that link is exactly how 15 forks lost their context on 9 Oct.

/** Fleet login name (max-logins.ts) → that account's config dir on forge. */
export const FORGE_MAX_LOGIN_DIRS: Record<string, string> = {
  second: '/home/amar/.claude-max',
  default: '/home/amar/.claude-max-default',
}

const FORGE_CANONICAL = '/home/amar/.claude'

function forgeLoginsFile(): string {
  return join(homedir(), '.config', 'console', 'forge-max-logins.json')
}

interface ForgeLoginsState {
  checkedAt: number
  /** login name → dir, ONLY for dirs that have credentials AND a linked `projects`. */
  present: Record<string, string>
  /** login name → epoch ms until which it must not be used (auth failed on the box). */
  unusable: Record<string, number>
}

function readForgeLogins(): ForgeLoginsState {
  try {
    const raw = JSON.parse(readFileSync(forgeLoginsFile(), 'utf8')) as Partial<ForgeLoginsState>
    return { checkedAt: raw.checkedAt ?? 0, present: raw.present ?? {}, unusable: raw.unusable ?? {} }
  } catch {
    return { checkedAt: 0, present: {}, unusable: {} }
  }
}

function writeForgeLogins(state: ForgeLoginsState): void {
  const path = forgeLoginsFile()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Pure: the shell that makes each logged-in account dir share the box's
 *  `~/.claude`, and reports the ones that are safe to spawn under.
 *
 *  A dir is reported (`LOGIN <name>`) only if it has credentials AND its
 *  `projects` resolves to the canonical one. A real directory the CLI created
 *  at login is moved aside, never deleted. */
export function forgeMaxLoginScript(dirs: Record<string, string>, shared: readonly string[]): string {
  const lines = ['set -u', `mkdir -p ${FORGE_CANONICAL}/projects`]
  for (const [name, dir] of Object.entries(dirs)) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(name) || !/^\/[A-Za-z0-9._/-]+$/.test(dir)) continue
    lines.push(
      `if [ -f ${dir}/.credentials.json ]; then`,
      `  for s in ${shared.join(' ')}; do`,
      `    src=${FORGE_CANONICAL}/$s; l=${dir}/$s`,
      '    [ -e "$src" ] || continue',
      '    [ -L "$l" ] && continue',
      '    [ -e "$l" ] && mv "$l" "$l.pre-link.$(date +%s)"',
      '    ln -s "$src" "$l"',
      '  done',
      `  [ "$(readlink ${dir}/projects)" = ${FORGE_CANONICAL}/projects ] && echo "LOGIN ${name}"`,
      'fi',
    )
  }
  lines.push('true')
  return lines.join('\n')
}

/** Pure: the desktop's settings.json for a Max login dir on the box — static
 *  credentials out, and every backend key out too, so the CLI talks to the
 *  subscription whatever the desktop file happens to carry. */
export function remoteMaxSettings(json: string): string {
  const parsed = JSON.parse(remoteSettings(json)) as { env?: Record<string, string> } & Record<string, unknown>
  if (parsed.env) for (const k of MANAGED_ENV_KEYS) delete parsed.env[k]
  return JSON.stringify(parsed, null, 2)
}

/** Link every logged-in account dir on the box, give it first-party settings,
 *  and record which accounts forge forks may spawn under. Never fatal: with no
 *  usable login a forge fork simply runs on Bedrock, as before. */
export async function syncForgeMaxLogins(cfg: ForgeConfig, log: (m: string) => void = () => {}): Promise<string[]> {
  const res = await forgeExec(cfg, forgeMaxLoginScript(FORGE_MAX_LOGIN_DIRS, SHARED_DIRS), { timeoutMs: 60_000 })
  if (res.code !== 0) {
    log(`[forge] Max login check failed (${res.stderr.trim().slice(0, 200)}) — keeping the previous record`)
    return Object.keys(readForgeLogins().present)
  }
  const present: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const m = /^LOGIN (\S+)$/.exec(line.trim())
    if (m && FORGE_MAX_LOGIN_DIRS[m[1]]) present[m[1]] = FORGE_MAX_LOGIN_DIRS[m[1]]
  }
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      const tmp = join(mkdtempSync(join(tmpdir(), 'forge-max-settings-')), 'settings.json')
      writeFileSync(tmp, remoteMaxSettings(readFileSync(settingsPath, 'utf8')), { mode: 0o600 })
      for (const [name, dir] of Object.entries(present)) {
        // A dir whose settings did not land could carry a stale Bedrock env and
        // silently bill per token while recorded as "on Max": drop it instead.
        if (!(await rsyncUp(cfg, tmp, `${dir}/settings.json`))) {
          log(`[forge] could not write settings for Max login '${name}' — not using it`)
          delete present[name]
        }
      }
    } catch (err) {
      log(`[forge] Max login settings failed (${(err as Error).message}) — not using any`)
      for (const name of Object.keys(present)) delete present[name]
    }
  }
  const prev = readForgeLogins()
  writeForgeLogins({ checkedAt: Date.now(), present, unusable: prev.unusable })
  log(`[forge] Max logins on the box: ${Object.keys(present).join(', ') || 'none'}`)
  return Object.keys(present)
}

/** The box-side config dir for a fleet login, or null when a forge fork must
 *  not use it (never logged in there, not linked, or recently failed auth). */
export function forgeMaxLoginDir(name: string, now = Date.now()): string | null {
  const s = readForgeLogins()
  const dir = s.present[name]
  if (!dir) return null
  if ((s.unusable[name] ?? 0) > now) return null
  return dir
}

/** A fork answered "Not logged in" under this account on the box: stop using
 *  it for a while so the next spawn falls back to Bedrock instead of repeating. */
export function markForgeMaxLoginUnusable(name: string, ttlMs = 30 * 60_000, now = Date.now()): void {
  const s = readForgeLogins()
  s.unusable[name] = now + ttlMs
  writeForgeLogins(s)
}

export type ForgeSpawnPlan = { backend: 'first_party'; configDir: string } | { backend: 'bedrock' }

/** Pure: which identity a forge fork spawns with.
 *
 *  It follows the fleet onto the subscription only when the fleet is on it AND
 *  the box has a usable login for the SAME account, so forge and the desktop
 *  draw on one weekly window and a spent window moves both. Everything else is
 *  Bedrock through the instance role, which needs nothing on the box. */
export function forgeSpawnPlan(fleetBackend: string, loginDir: string | null): ForgeSpawnPlan {
  return fleetBackend === 'first_party' && loginDir ? { backend: 'first_party', configDir: loginDir } : { backend: 'bedrock' }
}

export interface AgentEnvResult { ok: boolean; reason: string }

/** Mirror the agent-side config onto forge. Incremental (rsync), so after the
 *  first run this is fast enough to do before every remote dispatch. */
export async function syncAgentEnv(cfg: ForgeConfig, log: (m: string) => void = () => {}): Promise<AgentEnvResult> {
  const home = homedir()
  const prep = await forgeExec(cfg, 'mkdir -p /home/amar/.claude /home/amar/sync/brain')
  if (prep.code !== 0) return { ok: false, reason: `forge mkdir failed: ${prep.stderr.trim()}` }

  // The vault's own CLAUDE.md sits ABOVE the mounted project dir, so it is not
  // covered by the mount and has to be copied.
  for (const [local, remote] of [
    [join(home, 'CLAUDE.md'), '/home/amar/CLAUDE.md'],
    [join(home, 'sync/brain/CLAUDE.md'), '/home/amar/sync/brain/CLAUDE.md'],
  ] as const) {
    if (!(await rsyncUp(cfg, local, remote))) return { ok: false, reason: `rsync ${local} failed` }
  }

  for (const sub of ['skills', 'plugins'] as const) {
    const local = join(home, '.claude', sub)
    if (!existsSync(local)) continue
    await forgeExec(cfg, `mkdir -p /home/amar/.claude/${sub}`)
    if (!(await rsyncUp(cfg, local, `/home/amar/.claude/${sub}`, { dir: true }))) {
      return { ok: false, reason: `rsync .claude/${sub} failed` }
    }
  }

  const settingsPath = join(home, '.claude', 'settings.json')
  if (existsSync(settingsPath)) {
    let patched: string
    try {
      patched = remoteSettings(readFileSync(settingsPath, 'utf8'), remoteBedrockEnv())
    } catch (err) {
      return { ok: false, reason: `settings.json unparseable: ${(err as Error).message}` }
    }
    const tmp = join(mkdtempSync(join(tmpdir(), 'forge-settings-')), 'settings.json')
    writeFileSync(tmp, patched, { mode: 0o600 })
    const ok = await rsyncUp(cfg, tmp, '/home/amar/.claude/settings.json')
    if (!ok) return { ok: false, reason: 'rsync settings.json failed' }
  }

  // After skills/plugins exist in the canonical dir, so the account dirs can link
  // to them. Not fatal: no usable login just means Bedrock.
  await syncForgeMaxLogins(cfg, log)

  // ~/exec is referenced by $HOME-relative path from settings.json hooks, so an
  // EMPTY one on forge is not a missing convenience — it makes every Bash call
  // return a hook error. Astera's PostToolUse hook runs
  // `python3 $HOME/exec/astera-worktree-rules-hook.py`, which injects the app
  // repo's CLAUDE.md and .claude/rules/* when a fork touches a worktree; with
  // ~/exec empty that hook failed on every command AND the repo's rules were
  // silently absent, so a remote fork was writing Astera code without them
  // (^spry-boar, 8 Oct 2026). Scripts only: ~/exec also holds ~180 MB of
  // vendored binaries (mitmproxy, cloud-sql-proxy) that forge has no use for,
  // hence --max-size. No --delete: forge may have its own additions, and the
  // cost of a stale script there is far below the cost of deleting a live one.
  if (existsSync(join(home, 'exec'))) {
    await forgeExec(cfg, 'mkdir -p /home/amar/exec')
    const ok = await execFileP('rsync', ['-az', '--max-size=1m', '--exclude', '.git', '-e', 'ssh -o BatchMode=yes',
      `${join(home, 'exec')}/`, `${cfg.host}:/home/amar/exec/`],
      { env: sshEnvPath(), timeout: 600_000, maxBuffer: 8 * 1024 * 1024 }).then(() => true).catch(() => false)
    if (!ok) log('[forge] ~/exec did not sync — hooks that call $HOME/exec/* will fail on every Bash call')
  }

  log('[forge] agent env mirrored (CLAUDE.md ancestry, skills, plugins, settings, ~/exec scripts)')
  return { ok: true, reason: 'agent env mirrored' }
}

/** Copy only the `cli` bearer from local-tokens.json, so a remote fork's `con`
 *  authenticates to the hub over the reverse tunnel. The al/voice bearers stay
 *  on the desktop — forge has no business holding them. */
export async function syncCliToken(cfg: ForgeConfig): Promise<AgentEnvResult> {
  const local = join(homedir(), '.config', 'console', 'local-tokens.json')
  if (!existsSync(local)) return { ok: false, reason: 'no local-tokens.json' }
  let subset: string
  try {
    const d = JSON.parse(readFileSync(local, 'utf8')) as Record<string, unknown>
    if (!d.cli) return { ok: false, reason: 'local-tokens.json has no cli bearer' }
    subset = JSON.stringify({ version: d.version, cli: d.cli, mintedAt: d.mintedAt }, null, 2)
  } catch (err) {
    return { ok: false, reason: `local-tokens.json unparseable: ${(err as Error).message}` }
  }
  const dir = mkdtempSync(join(tmpdir(), 'forge-tok-'))
  const tmp = join(dir, 'local-tokens.json')
  writeFileSync(tmp, subset, { mode: 0o600 })
  await forgeExec(cfg, 'mkdir -p /home/amar/.config/console')
  const ok = await rsyncUp(cfg, tmp, '/home/amar/.config/console/local-tokens.json')
  if (!ok) return { ok: false, reason: 'rsync local-tokens.json failed' }
  await forgeExec(cfg, 'chmod 600 /home/amar/.config/console/local-tokens.json')
  return { ok: true, reason: 'cli bearer mirrored' }
}

/** Credential directories the box is allowed to hold, as an explicit
 *  allow-list rather than "whatever is under ~/.config".
 *
 *  `files` is a NAMED ALLOW-LIST, so the box's copy of a credential directory is
 *  exactly these files and a new credential on the desktop is private until it
 *  is listed here. Yousef chose this on 8 Oct 2026, narrowing his own earlier
 *  instruction (*"Copy ~/.config/astera/*.env to the box. Treat the box as an
 *  extension of my PC…"*): the glob put 41 files on the shared box including
 *  live Stripe, Xero, QuickBooks, Rippling payroll, Resend, D&B, PostHog,
 *  OpenAI, Airtable and Google OAuth credentials, when only these two have any
 *  box-side consumer at all.
 *
 *  What put the question on the table: `blob.env` held the REAL prod Vercel Blob
 *  read-write token, and Astera's ^quick-bear fork read it ON THE BOX. Blob is
 *  one bucket keyed by filename (Astera rule 143), so a fork uploading a fixed
 *  name with that token overwrites a PROD object. `app.env` deliberately carries
 *  a well-shaped FAKE blob token instead, which lets Payload's config load while
 *  the default upload path falls back to local disk. A hash sweep of the
 *  directory then found the same token duplicated into `front-sync.staging.env`,
 *  so withholding the obvious filename would have been a false all-clear —
 *  **a credential reaches the box by VALUE, not by filename.** An allow-list is
 *  the only form of this that does not need that sweep repeated for every new
 *  secret.
 *
 *  This runs on every prepare rather than being a one-shot copy, because the
 *  box is rebuilt from `provision.sh` whenever it is replaced and a silently
 *  credential-less box fails forks at their first database step — the exact
 *  class of failure that cost Astera a night already.
 *
 *  The destination is outside every git checkout on purpose: Astera repo rules
 *  6 and 163 forbid a secret entering a working tree, ignored scratch included.
 *
 *  **Nothing running ON the box may write into a mirrored directory**, because
 *  `--delete-excluded` makes the next prepare remove anything not on the list.
 *  True today: `worktree-db.sh` only READS neon.env and writes DATABASE_URL into
 *  the worktree's own .env; the only writer into ~/.config/astera is
 *  `demo/prepare.sh`, a desktop flow. A box-side script that needs to write a
 *  credential needs its own directory, not this one. */
const CREDENTIAL_MIRRORS = [
  {
    localDir: join('.config', 'astera'),
    remoteDir: '/home/amar/.config/astera',
    files: [
      // Symlinked in as .env by every worktree the box prepares (repo.ts appEnv).
      'app.env',
      // NEON_API_KEY, read by the app's scripts/worktree-db.sh and local-gate.sh
      // to fork a per-card database. This is the "first database step" above.
      'neon.env',
      // One line: STRIPE_SECRET_KEY holding the sk_test_ key, so a remote fork
      // can create Stripe TEST-mode objects for hand-back screenshots (asked by
      // Astera general, 9 Oct 2026, for ^pale-deer's promo codes page). A
      // test-mode key cannot move money. It is a separate file on purpose:
      // stripe.env also holds the sk_live_ key and the webhook secrets and
      // stays off the box. Checked before listing, by shape not by trust —
      // 0600, one key, sk_test_ prefix, no live or whsec_ string. Re-check
      // that if the file ever grows a second line.
      'stripe-test.env',
    ],
  },
] as const

/** The credential mirror's rsync argv.
 *
 *  Extracted only so the `--inplace` invariant below is testable.
 *
 *  **It must never gain `--inplace`.** `appEnv` leaves the box's copy of a
 *  mirrored file READ-ONLY so nothing can append through the symlinks that
 *  point at it, and rsync's default temp-file-and-rename happily replaces a
 *  0400 destination (verified end to end on the box, 8 Oct 2026: a 0400 file
 *  took an edited desktop copy's bytes and came back 0600). `--inplace` writes
 *  through the existing inode instead, which a 0400 file refuses — so the
 *  owner's edits would stop reaching the box while every mode and log line
 *  still looked correct. Astera general asked for this to be observed rather
 *  than inferred, for exactly that reason: "if a future edit of mine silently
 *  never lands, the whole arrangement looks fine and is wrong." */
export function credentialRsyncArgv(
  mirror: { files: readonly string[]; remoteDir: string },
  local: string,
  host: string,
): string[] {
  return [
    // --delete alone propagates a REVOCATION (a listed file deleted on the
    // desktop stops existing on the box). --delete-excluded is what makes the
    // allow-list retroactive: without it rsync deliberately PROTECTS files it
    // was told to exclude, so dropping a name here would stop that credential
    // being updated while leaving the copy already on the box — the worst of
    // both. With it, the box's copy of the directory is exactly `files`.
    '-a', '--chmod=D700,F600', '--delete', '--delete-excluded',
    ...mirror.files.flatMap((f) => ['--include', f]),
    '--exclude', '*',
    '-e', 'ssh -o BatchMode=yes',
    `${local}/`, `${host}:${mirror.remoteDir}/`,
  ]
}

export async function syncProjectCredentials(cfg: ForgeConfig, log: (m: string) => void = () => {}): Promise<AgentEnvResult> {
  for (const m of CREDENTIAL_MIRRORS) {
    const local = join(homedir(), m.localDir)
    if (!existsSync(local)) continue
    const prep = await forgeExec(cfg, `mkdir -p ${m.remoteDir} && chmod 700 ${m.remoteDir}`)
    if (prep.code !== 0) return { ok: false, reason: `could not create ${m.remoteDir} on forge: ${prep.stderr.trim()}` }
    const ok = await execFileP('rsync', credentialRsyncArgv(m, local, cfg.host),
      { env: sshEnvPath(), timeout: 600_000, maxBuffer: 8 * 1024 * 1024 }).then(() => true).catch(() => false)
    if (!ok) return { ok: false, reason: `credentials for ${m.localDir} did not reach forge — a fork needing them will fail at its first database step` }
    // Name them: the whole point of an allow-list is that reading the log tells
    // you what is on the box, which a glob never did.
    log(`[forge] credentials mirrored: ${m.files.join(', ')} → ${m.remoteDir} (0700/0600, nothing else kept there)`)
  }

  // The gh token deliberately does NOT auto-sync: it lives in the desktop's
  // keyring, so pushing it on every prepare would re-install a token Yousef had
  // revoked. Absent is fine; absent and SILENT is not, because a fork only
  // discovers it when `gh pr merge` fails at the end of its work.
  const gh = await forgeExec(cfg, 'test -s /home/amar/.config/gh/hosts.yml && echo present || echo missing')
  if (gh.stdout.includes('missing')) {
    log('[forge] NO gh token on the box — `gh pr merge` will fail for remote forks. Install it with scripts/forge/install-gh-token.sh')
  }
  return { ok: true, reason: 'project credentials mirrored' }
}

export { dirname }
