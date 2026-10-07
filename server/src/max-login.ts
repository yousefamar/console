// ============================================================================
// Is the Claude Max login actually usable? One tiny real turn says for sure.
//
// Why: on 7 Oct 2026 the fleet was switched back to the subscription while its
// OAuth login was dead, and every session died on "Failed to authenticate:
// OAuth session expired and could not be refreshed". Two things lined up: the
// fleet had sat on Bedrock for hours, so no `claude` process had refreshed the
// Max token (the hub only ever READS it — subscription-usage.ts); and a probe run
// on a COPY of the credentials refreshed it there, which rotated the refresh
// token and left the real file holding a revoked one. So:
//   - the check runs against the REAL config dir, so a refresh it performs is
//     written back where every session reads it — never copy the credentials;
//   - `--settings` env (which outranks settings.json's) forces first-party even
//     while the fleet is on Bedrock, and a bare model id proves it: Bedrock
//     would 400 on it;
//   - API-key vars are stripped, or the turn would bill the API and prove
//     nothing about the subscription.
// `claude auth status` is no substitute: it reports `loggedIn: true` from the
// file alone, expired token or not.
// ============================================================================

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

export type MaxLoginCheck =
  | { ok: true }
  | { ok: false; auth: boolean; detail: string }

export const PROBE_MODEL = 'claude-haiku-4-5-20251001'

/** Vars that would make the probe something other than "a fresh first-party
 *  CLI on the subscription login": a hub child's session wiring, and API keys. */
const STRIPPED_ENV = [
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'CLAUDE_CODE_ENTRYPOINT',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
]

/** `configDir` probes a SPECIFIC Max login (max-logins.ts) rather than whichever
 *  one the fleet is on — that is how a rotation candidate is checked before the
 *  fleet moves onto it. Still the login's REAL dir, never a copy of it: the
 *  refresh this probe performs must land where that login's sessions read it. */
export function maxLoginEnv(base: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const k of STRIPPED_ENV) delete env[k]
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  return env
}

export function maxLoginArgs(): string[] {
  const settings = {
    env: {
      CLAUDE_CODE_USE_BEDROCK: '0',
      ANTHROPIC_MODEL: PROBE_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: PROBE_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: PROBE_MODEL,
    },
  }
  return ['-p', '--settings', JSON.stringify(settings), '--model', PROBE_MODEL,
    '--strict-mcp-config', '--output-format', 'json', 'Reply with exactly OK']
}

const AUTH_RE = /authenticat|oauth|log ?in|401|unauthori[sz]ed|invalid.{0,20}token|token.{0,20}(expired|revoked)/i

/** Pure: read the CLI's exit + output. */
export function classifyMaxLogin(code: number | null, stdout: string, stderr: string): MaxLoginCheck {
  let result = ''
  let isError = code !== 0
  try {
    const d = JSON.parse(stdout) as { is_error?: boolean; result?: string }
    result = typeof d.result === 'string' ? d.result : ''
    isError = isError || d.is_error === true
  } catch {
    isError = true
  }
  if (!isError && /\bOK\b/.test(result)) return { ok: true }
  const detail = (result || stderr || stdout || `exit ${code}`).trim().replace(/\s+/g, ' ').slice(0, 300)
  return { ok: false, auth: AUTH_RE.test(`${result}\n${stderr}\n${stdout}`), detail }
}

export function checkMaxLogin(opts: { timeoutMs?: number; configDir?: string } = {}): Promise<MaxLoginCheck> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: MaxLoginCheck) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const proc = spawn('claude', maxLoginArgs(), { cwd: tmpdir(), env: maxLoginEnv(process.env, opts.configDir), stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done({ ok: false, auth: false, detail: `no answer in ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)
    proc.stdout.on('data', (c) => { stdout += c })
    proc.stderr.on('data', (c) => { stderr += c })
    proc.on('error', (e) => done({ ok: false, auth: false, detail: `could not run claude: ${e.message}` }))
    proc.on('close', (code) => done(classifyMaxLogin(code, stdout, stderr)))
  })
}
