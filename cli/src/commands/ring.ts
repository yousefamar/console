// con ring — Pebble Index 01 smart ring: webhook archive + command router.
//
// The ring's app POSTs every recording to the hub (/ring/webhook); the hub
// files audio + transcript away and routes the transcript as a command
// (server/src/ring/). `say` feeds the same pipeline with typed text so the
// schema can be exercised without wearing the ring.

import { writeFileSync } from 'node:fs'
import { hubFetch } from '../client.js'
import { output, info, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function ring(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return ringStatus(flags)
    case 'setup': return ringSetup(args, flags)
    case 'list': return ringList(args, flags)
    case 'show': return ringShow(args, flags)
    case 'audio': return ringAudio(args, flags)
    case 'say': return ringSay(args, flags)
    case 'schema': return ringSchema(args, flags)
    default:
      exitWithError('USAGE', `Unknown ring command: ${verb}. Verbs: status, setup, list, show, audio, say, schema. Run 'con help ring'.`, flags)
  }
}

async function ringStatus(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/ring/status'), flags)
}

// con ring setup [--name <token-name>] — mint a ring-scoped bearer and print
// exactly what to paste into the Pebble app's webhook settings. The plaintext
// is shown ONCE; re-run to mint another (revoke old ones via /auth/hub/tokens).
async function ringSetup(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const name = opts.name ?? `pebble-ring-${new Date().toISOString().slice(0, 10)}`
  const status = await hubFetch<{ webhookUrl: string }>('/ring/status')
  const tok = await hubFetch<{ id: string; plaintext: string }>('/auth/hub/tokens', { method: 'POST', body: { name, scope: 'ring' } })
  if (flags.json) { output({ webhookUrl: status.webhookUrl, tokenId: tok.id, header: `Authorization: Bearer ${tok.plaintext}` }, flags); return }
  info('Pebble app → Index tab → settings → Webhook:')
  info(`  Webhook URL:  ${status.webhookUrl}`)
  info(`  Header:       Authorization: Bearer ${tok.plaintext}`)
  info('  Send:         both (audio + transcription)')
  info('  Trigger:      the button combo you want to reach Console (e.g. double click-hold)')
  info(`Token "${name}" (${tok.id}) is shown once — revoke via DELETE /auth/hub/tokens/${tok.id}.`)
}

async function ringList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch<{ recordings: Array<{ id: string; recordedAt: number; transcription: string | null; transcriptionSource: string | null; audio: { bytes: number } | null; route?: { via: string; rule?: string; ok: boolean; command: { kind: string } } }> }>('/ring/recordings', { params: { limit: opts.limit ?? '20' } })
  if (flags.json) { output(data, flags); return }
  for (const r of data.recordings) {
    const when = new Date(r.recordedAt).toISOString().replace('T', ' ').slice(0, 19)
    const route = r.route ? `${r.route.ok ? '✓' : '✗'} ${r.route.via}${r.route.rule ? `/${r.route.rule}` : ''}` : '—'
    info(`${r.id}  ${when}  ${r.audio ? `${Math.round(r.audio.bytes / 1024)}K` : 'no-audio'}  [${r.transcriptionSource ?? 'none'}] ${route}  ${r.transcription ?? ''}`)
  }
  if (!data.recordings.length) info('No recordings yet.')
}

async function ringShow(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) exitWithError('USAGE', 'Usage: con ring show <id>', flags)
  output(await hubFetch(`/ring/recordings/${encodeURIComponent(id!)}`), flags)
}

// con ring audio <id> [--out <path>] — download the M4A.
async function ringAudio(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) exitWithError('USAGE', 'Usage: con ring audio <id> [--out <path.m4a>]', flags)
  const res = await hubFetch<Response>(`/ring/recordings/${encodeURIComponent(id!)}/audio`, { raw: true })
  if (!res.ok) exitWithError(res.status === 404 ? 'NOT_FOUND' : 'ERROR', `HTTP ${res.status}`, flags)
  const out = opts.out ?? `${id}.m4a`
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  output({ saved: out }, flags)
}

// con ring say "<text>" — simulate a ring transcript (no audio) through the
// full router → execution → push path.
async function ringSay(args: string[], flags: GlobalFlags): Promise<void> {
  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!text) exitWithError('USAGE', 'Usage: con ring say "<transcript>"', flags)
  output(await hubFetch('/ring/webhook', { method: 'POST', body: { transcription: text, client: 'cli' } }), flags)
}

// con ring schema [--check] — the effective command tree from the vault note
// (projects/console/ring-schema.md), every target resolved. --check exits
// non-zero on parse errors or unresolvable targets (for a pre-commit sanity run).
async function ringSchema(args: string[], flags: GlobalFlags): Promise<void> {
  const check = args.includes('--check')
  const d = await hubFetch<{
    path: string; errors: string[]; stale: boolean
    fallback: { agentKey: string | null; live: boolean }; llmFallback: boolean
    verbs: Array<{ verb: string; aliases: string[]; usage: string; note?: string; targets: Array<{ name: string; resolves: string; ok: boolean; note?: string }> }>
  }>('/ring/schema')
  const broken = d.verbs.flatMap((v) => v.targets.filter((t) => !t.ok).map((t) => `${v.verb} ${t.name} → ${t.resolves}: ${t.note ?? 'unresolved'}`))
  if (flags.json) { output({ ...d, broken }, flags); return }
  info(`${d.path}${d.stale ? '  (UNPARSEABLE — using last good)' : ''}`)
  for (const e of d.errors) info(`  ! ${e}`)
  for (const v of d.verbs) {
    info(`${v.usage}${v.aliases.length ? `   aliases: ${v.aliases.join(', ')}` : ''}`)
    for (const t of v.targets) info(`  ${t.ok ? '·' : '✗'} ${t.name.padEnd(14)} → ${t.resolves}${t.note ? `   (${t.note})` : ''}`)
    if (v.note) info(`    ${v.note}`)
  }
  info(`fallback → ${d.fallback.agentKey ?? 'none (notify only)'}${d.fallback.agentKey ? (d.fallback.live ? '' : '  ✗ not live') : ''}   llm fallback: ${d.llmFallback ? 'on' : 'off'}`)
  if (check && (d.stale || d.errors.length || broken.length || (d.fallback.agentKey && !d.fallback.live))) {
    exitWithError('SCHEMA', `${d.errors.length} error(s), ${broken.length} unresolved target(s)`, flags)
  }
}
