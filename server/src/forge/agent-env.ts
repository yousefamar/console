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
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ForgeConfig } from './config.js'
import { forgeExec } from './ssh.js'

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

/** Strip the desktop's static-credential profile out of settings.json so the
 *  remote process falls through to the instance role. */
export function remoteSettings(json: string): string {
  const parsed = JSON.parse(json) as { env?: Record<string, string> } & Record<string, unknown>
  if (parsed.env) {
    delete parsed.env.AWS_PROFILE
    delete parsed.env.AWS_BEARER_TOKEN_BEDROCK
    delete parsed.env.AWS_ACCESS_KEY_ID
    delete parsed.env.AWS_SECRET_ACCESS_KEY
  }
  return JSON.stringify(parsed, null, 2)
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
      patched = remoteSettings(readFileSync(settingsPath, 'utf8'))
    } catch (err) {
      return { ok: false, reason: `settings.json unparseable: ${(err as Error).message}` }
    }
    const tmp = join(mkdtempSync(join(tmpdir(), 'forge-settings-')), 'settings.json')
    writeFileSync(tmp, patched, { mode: 0o600 })
    const ok = await rsyncUp(cfg, tmp, '/home/amar/.claude/settings.json')
    if (!ok) return { ok: false, reason: 'rsync settings.json failed' }
  }

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
