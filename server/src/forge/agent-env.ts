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

export { dirname }
