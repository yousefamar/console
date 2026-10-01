#!/usr/bin/env tsx
// Synthetic probe for `clear_tool_uses_20250919` on Bedrock (card ^plum-fawn).
//
// Grows a fake tool-use conversation one exchange at a time and prints, per
// request, what the API cleared and what it read/wrote from cache — the two
// facts the economics hinge on: (1) does the edit clear ALL results but the
// last `keep`, or only down to the trigger; (2) how many tokens are rewritten
// per call once clearing is active. Costs ~$0.05–0.3 per call on haiku.
//
//   tsx scripts/spend/context-probe.ts --model haiku --from 10 --to 40 --step 5 --fill 6000 --clear
//   tsx scripts/spend/context-probe.ts --model fable --from 30 --to 33 --clear --keep 3 --trigger 50000
//
// Uses the same signer + eventstream parser as the hub's context proxy.
import { request } from 'node:https'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadAwsCredentials, signV4 } from '../../server/src/agents/sigv4.js'
import { EventStreamParser, bedrockHost, CONTEXT_BETA, CLEAR_EDIT_TYPE } from '../../server/src/agents/context-proxy.js'

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const flag = (k: string) => process.argv.includes(`--${k}`)

const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8')) as { env: Record<string, string> }
const env = settings.env
const region = env.AWS_REGION ?? 'us-east-1'
const profile = env.AWS_PROFILE ?? 'bedrock-amar'
const modelKey = arg('model', 'haiku')
const modelId = String(({ haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, fable: env.ANTHROPIC_MODEL, opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL } as Record<string, string>)[modelKey] ?? modelKey).replace(/\[1m\]$/, '')
const from = Number(arg('from', '10')), to = Number(arg('to', '20')), step = Number(arg('step', '1'))
const fill = Number(arg('fill', '6000'))
const keep = Number(arg('keep', '3')), trigger = Number(arg('trigger', '100000'))
const clear = flag('clear'), clearInputs = flag('inputs')
const ttl = arg('ttl', '5m')
const forceAt = new Set(arg('force-at', '').split(',').filter(Boolean).map(Number))   // force a clear (trigger=1) on these n
const creds = loadAwsCredentials(profile)
if (!creds) throw new Error(`no creds for ${profile}`)

// Deterministic filler: varied words so tokenisation is realistic (~4 chars/token).
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu config server socket buffer stream parse token cache write read'.split(' ')
function filler(seed: number, chars: number): string {
  let s = seed * 2654435761 >>> 0, out = `doc-${seed}: `
  while (out.length < chars) { s = (s * 1103515245 + 12345) >>> 0; out += WORDS[s % WORDS.length] + (s % 7 === 0 ? '\n' : ' ') }
  return out.slice(0, chars)
}

function conversation(n: number): Array<Record<string, unknown>> {
  // Append-only, Claude-Code-shaped: the breakpoint rides the LAST tool_result,
  // so the previous call's breakpoint position is a prefix of this call.
  const msgs: Array<Record<string, unknown>> = [{ role: 'user', content: [{ type: 'text', text: 'Fetch documents 1..N one at a time with get_doc, one call per turn, no commentary.' }] }]
  for (let i = 1; i <= n; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${String(i).padStart(4, '0')}`, name: 'get_doc', input: { id: i, note: filler(1000 + i, Number(arg('infill', '200'))) } }] })
    const tr: Record<string, unknown> = { type: 'tool_result', tool_use_id: `toolu_${String(i).padStart(4, '0')}`, content: filler(i, fill) }
    if (i === n) tr.cache_control = { type: 'ephemeral', ttl }
    msgs.push({ role: 'user', content: [tr] })
  }
  return msgs
}

async function call(n: number): Promise<void> {
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 5,
    system: [{ type: 'text', text: 'You are a terse assistant in a synthetic benchmark. ' + filler(99, 3000), cache_control: { type: 'ephemeral', ttl } }],
    tools: [{ name: 'get_doc', description: 'Fetch a document by id', input_schema: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string' } }, required: ['id'] } }],
    messages: conversation(n),
    anthropic_beta: [CONTEXT_BETA],
  }
  if (clear) {
    const edits: Array<Record<string, unknown>> = []
    if (flag('thinking-edit')) edits.push({ type: 'clear_thinking_20251015', keep: 'all' })   // what Claude Code itself sends
    edits.push({ type: CLEAR_EDIT_TYPE, trigger: { type: 'input_tokens', value: forceAt.has(n) ? 1 : trigger }, keep: { type: 'tool_uses', value: keep }, clear_tool_inputs: clearInputs })
    body.context_management = { edits }
  }
  const buf = Buffer.from(JSON.stringify(body))
  const host = bedrockHost(region)
  const path = `/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`
  const headers = signV4({ method: 'POST', host, path, headers: { 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream' }, body: buf, region, service: 'bedrock', credentials: creds! })
  const t0 = Date.now()
  await new Promise<void>((resolve, reject) => {
    const req = request({ host, path, method: 'POST', headers }, (res) => {
      const p = new EventStreamParser()
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => { p.feed(c); chunks.push(c) })
      res.on('end', () => {
        const u = p.usage
        const ctx = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
        const ae = u.appliedEdits?.[0] as Record<string, unknown> | undefined
        if (res.statusCode !== 200) console.log(`n=${n} HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf-8').slice(0, 400)}`)
        else console.log(`n=${String(n).padStart(3)} orig=${ctx + Number(ae?.cleared_input_tokens ?? 0)}  ctx=${ctx}  in=${u.input}  cache_read=${u.cacheRead}  cache_write=${u.cacheWrite}  ` +
          `cleared=${ae ? `${ae.cleared_tool_uses}u/${ae.cleared_input_tokens}t` : '-'}  stop=${u.stopReason}  ${Date.now() - t0}ms${u.exception ? '  EXC ' + u.exception : ''}`)
        resolve()
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(buf)
  })
}

console.log(`model=${modelId.slice(-30)} fill=${fill} chars/result  clear=${clear} keep=${keep} trigger=${trigger} inputs=${clearInputs} ttl=${ttl}`)
for (let n = from; n <= to; n += step) await call(n)
