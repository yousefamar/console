// con cron — manage hub-side scheduled prompts that fire into agent sessions.
//
// Tasks survive hub restarts (unlike Claude Code's built-in CronCreate, which
// only lives inside one Claude session and breaks under our SDK transport —
// see ~/.claude/plans/imperative-cooking-grove.md). Sessions are referenced by
// claudeSessionId only; look it up with `con agent list --json`.

import { hubFetch, getHubUrl } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

interface HubCronTask {
  id: string
  claudeSessionId: string
  trigger: string
  recurring: boolean
  prompt: string
  createdAt: number
  lastFiredAt?: number
  lastSkipReason?: string
  consecutiveSkips: number
  disabledAt?: number
}

const HUB_SESSION_ID_PREFIX = 'session_'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function cron(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return listCmd(args, flags)
    case 'add': return addCmd(args, flags)
    case 'remove':
    case 'rm':
    case 'delete':
      return removeCmd(args, flags)
    case 'run': return runCmd(args, flags)
    case 'upcoming': return upcomingCmd(args, flags)
    case 'ics-url': return icsUrlCmd(flags)
    default:
      exitWithError('USAGE', `Unknown cron command: ${verb ?? ''}. Try: list, add, remove, run, upcoming, ics-url.`, flags)
  }
}

// --------------------------------------------------------------------------

async function listCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const qs = opts.session ? `?session=${encodeURIComponent(opts.session)}` : ''
  const tasks = await hubFetch<HubCronTask[]>(`/cron${qs}`)
  output(tasks, flags)
}

async function addCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const claudeSessionId = String(opts.session ?? '')
  if (!claudeSessionId) {
    exitWithError('USAGE', 'Usage: con cron add --session <claudeSessionId> --trigger "<cron-or-iso-or-+15m>" --prompt "<text>" [--once] [--guard "<shell cmd>" | --guard-file <path>]', flags); return
  }
  if (claudeSessionId.startsWith(HUB_SESSION_ID_PREFIX)) {
    exitWithError('USAGE', 'Use claudeSessionId (UUID) from `con agent list --json | jq \'.[].claudeSessionId\'`, not the hub session id.', flags); return
  }
  if (claudeSessionId !== 'al' && !UUID_RE.test(claudeSessionId)) {
    exitWithError('USAGE', `--session must be a claudeSessionId (UUID) or "al". Got: ${claudeSessionId}`, flags); return
  }

  let trigger = String(opts.trigger ?? '')
  const prompt = String(opts.prompt ?? '')
  // Optional token-free guard: a shell command run at each trigger; the agent
  // is woken ONLY when it exits 0 (non-zero = "nothing to do", skipped). Its
  // stdout is appended to the prompt. --guard "<cmd>" or --guard-file <path>.
  let guard = opts.guard ? String(opts.guard) : undefined
  if (!guard && opts['guard-file']) {
    const { readFileSync } = await import('node:fs')
    guard = readFileSync(String(opts['guard-file']), 'utf-8')
  }
  if (!trigger) { exitWithError('USAGE', '--trigger is required (5-field cron, ISO datetime, or relative shorthand like +30m)', flags); return }
  if (!prompt)  { exitWithError('USAGE', '--prompt is required', flags); return }

  // Resolve relative shorthand client-side: +30m, +2h, +1d, +90s
  const isRelative = /^\+\d+\s*[smhd]$/i.test(trigger.trim())
  const isIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trigger)
  let recurring = !(opts.once === 'true')
  if (isRelative) {
    trigger = relativeToIso(trigger.trim())
    recurring = false
  } else if (isIso) {
    recurring = false
  }

  const task = await hubFetch<HubCronTask>('/cron', {
    method: 'POST',
    body: { claudeSessionId, trigger, prompt, recurring, ...(guard ? { guard } : {}) },
  })
  output(task, flags)
}

async function removeCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) { exitWithError('USAGE', 'Usage: con cron remove <task-id>', flags); return }
  const r = await hubFetch<{ removed: boolean }>(`/cron/${encodeURIComponent(id)}`, { method: 'DELETE' })
  output(r, flags)
}

async function runCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) { exitWithError('USAGE', 'Usage: con cron run <task-id>', flags); return }
  const r = await hubFetch<{ ok: boolean; reason?: string }>(`/cron/${encodeURIComponent(id)}/run`, { method: 'POST' })
  output(r, flags)
}

async function upcomingCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const n = opts.n ? parseInt(opts.n, 10) : 20
  const r = await hubFetch<Array<{ task: HubCronTask; fires: string[] }>>(`/cron/upcoming?n=${n}`)
  output(r, flags)
}

async function icsUrlCmd(flags: GlobalFlags): Promise<void> {
  const r = await hubFetch<{ token: string; publicUrl: string | null }>('/cron/ics-token')
  // Prefer the Tailscale-Funnel-reachable URL (works in GCal etc.); fall back to
  // tailnet-only local URL if no funnel mapping is set up.
  const localUrl = `${getHubUrl()}/cron.ics?token=${r.token}`
  const url = r.publicUrl ?? localUrl
  if (flags.json) output({ url, publicUrl: r.publicUrl, localUrl, token: r.token }, flags)
  else process.stdout.write(url + '\n')
}

// --------------------------------------------------------------------------

function relativeToIso(s: string): string {
  const m = s.match(/^\+(\d+)\s*([smhd])$/i)
  if (!m) throw new Error(`bad relative trigger: ${s}`)
  const n = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  const ms = n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!
  return new Date(Date.now() + ms).toISOString()
}
