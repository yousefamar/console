// con webhook — inbound webhooks for projects.
//
// A third party POSTs to https://con.amar.io/hub/hook/<project> with the
// project's token; the hub archives the delivery and wakes the project's
// owner (board default_owner: → bound-session convention) with the payload.
// The owner decides what it means. `test` runs the same pipeline from here.

import { hubFetch } from '../client.js'
import { output, info, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags, unknownFlags } from './util.js'

const BOOLEAN_FLAGS = new Set(['rotate'])

/** Positionals = tokens that are neither a flag nor a value-taking flag's value. */
function positionals(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) { out.push(a); continue }
    if (!a.includes('=') && !BOOLEAN_FLAGS.has(a.slice(2)) && i + 1 < args.length && !args[i + 1]!.startsWith('--')) i++
  }
  return out
}

function flagsOf(args: string[], allowed: readonly string[], flags: GlobalFlags): Record<string, string> {
  const opts = parseFlags(args)
  const bad = unknownFlags(opts, allowed)
  if (bad.length) exitWithError('USAGE', `Unknown flag(s): ${bad.map((b) => `--${b}`).join(', ')}. Allowed: ${allowed.map((a) => `--${a}`).join(', ') || 'none'}`, flags)
  return opts
}

export async function webhook(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return webhookStatus(flags)
    case 'setup': return webhookSetup(args, flags)
    case 'list': return webhookList(args, flags)
    case 'show': return webhookShow(args, flags)
    case 'test': return webhookTest(args, flags)
    case 'redeliver': return webhookRedeliver(args, flags)
    default:
      exitWithError('USAGE', `Unknown webhook command: ${verb}. Verbs: status, setup, list, show, test, redeliver. Run 'con help webhook'.`, flags)
  }
}

interface ProjectStatus {
  project: string; url: string; token: { id: string; createdAt: number; lastUsedAt: number | null } | null
  owner: string | null; ownerLive: boolean; deliveries: number; undelivered: number; lastReceivedAt: number | null
}

const when = (ms: number | null) => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '—'

async function webhookStatus(flags: GlobalFlags): Promise<void> {
  const d = await hubFetch<{ projects: ProjectStatus[] }>('/webhooks')
  if (flags.json) { output(d, flags); return }
  if (!d.projects.length) { info('No project webhooks yet — con webhook setup <project>.'); return }
  for (const p of d.projects) {
    const owner = p.owner ? `@${p.owner}${p.ownerLive ? '' : ' (not live)'}` : 'NO OWNER'
    info(`${p.project.padEnd(18)} ${p.token ? 'token ' + p.token.id : 'NO TOKEN'}  owner ${owner}  ${p.deliveries} deliveries${p.undelivered ? ` (${p.undelivered} undelivered)` : ''}  last ${when(p.lastReceivedAt)}`)
    info(`  ${p.url}`)
  }
}

// con webhook setup <project> [--rotate] — mint the project's token and print
// the URL to give the provider. Plaintext is shown ONCE.
async function webhookSetup(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['rotate'], flags)
  const project = positionals(args)[0]
  if (!project) exitWithError('USAGE', 'Usage: con webhook setup <project> [--rotate]', flags)
  const d = await hubFetch<{ project: string; url: string; urlWithToken: string; header: string; tokenId: string; revoked: string[]; owner: string | null; ownerLive: boolean }>(
    `/webhooks/${encodeURIComponent(project!)}/setup`, { method: 'POST', body: { rotate: !!opts.rotate } })
  if (flags.json) { output(d, flags); return }
  info(`Webhook for project ${d.project}${d.revoked.length ? ` (rotated — revoked ${d.revoked.join(', ')})` : ''}:`)
  info(`  URL:            ${d.url}`)
  info(`  Header:         ${d.header}`)
  info(`  or URL+token:   ${d.urlWithToken}`)
  info(`  Routes to:      ${d.owner ? `@${d.owner}${d.ownerLive ? '' : ' (not live right now)'}` : 'NO OWNER — bind a session to the project or set default_owner: on its board'}`)
  info(`Token ${d.tokenId} is shown once — re-run with --rotate to replace it.`)
}

async function webhookList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['limit'], flags)
  const project = positionals(args)[0]
  if (!project) exitWithError('USAGE', 'Usage: con webhook list <project> [--limit N]', flags)
  const d = await hubFetch<{ deliveries: Array<{ id: string; receivedAt: number; method: string; subpath: string; contentType: string | null; bodyBytes: number; source: string | null; via: string; bodyPreview: string; route: { owner: string | null; delivered: boolean; detail?: string }; redeliveries?: Array<{ delivered: boolean }> }> }>(
    `/webhooks/${encodeURIComponent(project!)}/deliveries`, { params: { limit: opts.limit ?? '20' } })
  if (flags.json) { output(d, flags); return }
  for (const r of d.deliveries) {
    const landed = r.route.delivered || (r.redeliveries ?? []).some((x) => x.delivered)
    const to = r.route.owner ? `@${r.route.owner}` : 'no owner'
    info(`${r.id}  ${when(r.receivedAt)}  ${r.method} ${r.subpath || '/'}  ${r.bodyBytes}B  ${landed ? '✓' : '✗'} ${to}${!landed && r.route.detail ? ` (${r.route.detail})` : ''}  ${r.bodyPreview.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
  if (!d.deliveries.length) info('No deliveries yet.')
}

async function webhookShow(args: string[], flags: GlobalFlags): Promise<void> {
  flagsOf(args, [], flags)
  const id = positionals(args)[0]
  if (!id) exitWithError('USAGE', 'Usage: con webhook show <id>', flags)
  output(await hubFetch(`/webhooks/deliveries/${encodeURIComponent(id!)}`), flags)
}

// con webhook test <project> [--body '<json or text>'] [--content-type <ct>] —
// run the full pipeline (archive + wake the owner) without a token.
async function webhookTest(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = flagsOf(args, ['body', 'content-type'], flags)
  const project = positionals(args)[0]
  if (!project) exitWithError('USAGE', 'Usage: con webhook test <project> [--body <text|json>] [--content-type <ct>]', flags)
  let body: unknown = opts.body ?? { test: true, from: 'con webhook test', at: new Date().toISOString() }
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* plain text */ } }
  output(await hubFetch(`/webhooks/${encodeURIComponent(project!)}/test`, { method: 'POST', body: { body, contentType: opts['content-type'] } }), flags)
}

async function webhookRedeliver(args: string[], flags: GlobalFlags): Promise<void> {
  flagsOf(args, [], flags)
  const id = positionals(args)[0]
  if (!id) exitWithError('USAGE', 'Usage: con webhook redeliver <id>', flags)
  output(await hubFetch(`/webhooks/deliveries/${encodeURIComponent(id!)}/redeliver`, { method: 'POST', body: {} }), flags)
}
