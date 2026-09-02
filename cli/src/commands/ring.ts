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
    case 'config': return ringConfig(args, flags)
    default:
      exitWithError('USAGE', `Unknown ring command: ${verb}. Verbs: status, setup, list, show, audio, say, config. Run 'con help ring'.`, flags)
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

// con ring config [--fallback <agentKey|none>] [--llm on|off]
async function ringConfig(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const body: Record<string, unknown> = {}
  if (opts.fallback !== undefined) body.fallbackAgent = opts.fallback === 'none' ? null : opts.fallback
  if (opts.llm !== undefined) body.llmFallback = opts.llm !== 'off' && opts.llm !== 'false'
  if (!Object.keys(body).length) {
    const s = await hubFetch<{ config: unknown }>('/ring/status')
    output(s.config, flags)
    return
  }
  output(await hubFetch('/ring/config', { method: 'POST', body }), flags)
}
