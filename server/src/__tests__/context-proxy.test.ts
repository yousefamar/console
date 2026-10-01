import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signV4, parseAwsProfile, rfc3986 } from '../agents/sigv4.js'
import {
  analyzeBody, injectClearEdit, decideTrigger, conversationKey, EventStreamParser, ContextProxy, ProxyConfigStore,
  CLEAR_EDIT_TYPE, CONTEXT_BETA, DEFAULT_POLICY, FORCE_CLEAR_TRIGGER, NO_CLEAR_TRIGGER, SESSION_HEADER, SPAWN_HEADER,
  type Composition,
} from '../agents/context-proxy.js'

// AWS's published SigV4 example (docs: "Signature Version 4 signing process →
// example"): GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08
// at 20150830T123600Z with AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY.
describe('signV4', () => {
  it('reproduces the AWS documentation vector', () => {
    const h = signV4({
      method: 'GET', host: 'iam.amazonaws.com', path: '/', query: 'Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: Buffer.alloc(0), region: 'us-east-1', service: 'iam',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'), contentSha256Header: false,
    })
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, ' +
      'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
    expect(h['x-amz-date']).toBe('20150830T123600Z')
  })

  it('double-encodes the path (the inference-profile ARN arrives encoded once)', () => {
    expect(rfc3986('arn%3Aaws%3Abedrock')).toBe('arn%253Aaws%253Abedrock')
    expect(rfc3986("a b!*'()")).toBe('a%20b%21%2A%27%28%29')
  })

  it('parses a profile out of an INI credentials file', () => {
    const ini = '[default]\naws_access_key_id = A\n\n[bedrock-amar]\naws_access_key_id = AKIA1 ; trailing\naws_secret_access_key=S/1+x\n[other]\naws_access_key_id = Z\n'
    expect(parseAwsProfile(ini, 'bedrock-amar')).toEqual({ aws_access_key_id: 'AKIA1', aws_secret_access_key: 'S/1+x' })
    expect(parseAwsProfile('[profile p]\nregion = eu-west-2\n', 'p')).toEqual({ region: 'eu-west-2' })
    expect(parseAwsProfile(ini, 'missing')).toBeNull()
  })
})

function toolBody(n: number, resultChars = 1000): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'start' }]
  for (let i = 1; i <= n; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: `t${i}`, name: i % 2 ? 'Read' : 'Bash', input: { x: 'y'.repeat(50) } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'r'.repeat(resultChars) }] }] })
  }
  return { system: [{ type: 'text', text: 'sys'.repeat(100) }], tools: [{ name: 'Read' }, { name: 'Bash' }], messages, anthropic_beta: ['x-1'],
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } }
}

describe('analyzeBody', () => {
  it('splits the prompt into parts and measures the stale share beyond keep', () => {
    const c = analyzeBody(toolBody(8), 123, 3)
    expect(c.toolUses).toBe(8)
    expect(c.messages).toBe(17)
    expect(c.chars.toolResult).toBe(8000)
    expect(c.stale.n).toBe(5)
    expect(c.stale.toolResult).toBe(5000)
    expect(c.stale.toolInput).toBe(5 * JSON.stringify({ x: 'y'.repeat(50) }).length)
    expect(c.chars.system).toBe(300)
    expect(c.chars.tools).toBeGreaterThan(0)
    expect(c.betas).toEqual(['x-1'])
    expect(c.clientEdits).toEqual(['clear_thinking_20251015'])
  })
  it('nothing is stale with fewer tool uses than keep', () => {
    expect(analyzeBody(toolBody(2), 1, 3).stale).toEqual({ toolResult: 0, toolInput: 0, n: 0 })
  })
})

describe('injectClearEdit', () => {
  it('appends to the client\'s edits, declares the beta, and is idempotent', () => {
    const body = toolBody(4)
    expect(injectClearEdit(body, { ...DEFAULT_POLICY, keep: 5, excludeTools: ['Agent'] }, 12345)).toBe(true)
    const cm = body.context_management as { edits: Array<Record<string, unknown>> }
    expect(cm.edits.map((e) => e.type)).toEqual(['clear_thinking_20251015', CLEAR_EDIT_TYPE])
    expect(cm.edits[1]).toMatchObject({ trigger: { type: 'input_tokens', value: 12345 }, keep: { type: 'tool_uses', value: 5 }, clear_tool_inputs: false, exclude_tools: ['Agent'] })
    expect(body.anthropic_beta).toEqual(['x-1', CONTEXT_BETA])
    expect(injectClearEdit(body, DEFAULT_POLICY, 1)).toBe(false)
    expect((body.context_management as { edits: unknown[] }).edits).toHaveLength(2)
  })
})

describe('decideTrigger', () => {
  const comp = (staleChars: number): Composition => ({ bytes: 0, messages: 0, toolUses: 0, betas: [], clientEdits: [],
    chars: { system: 0, tools: 0, toolResult: 0, toolInput: 0, assistant: 0, user: 0, thinking: 0, images: 0 }, stale: { toolResult: staleChars, toolInput: 0, n: 0 } })
  const now = 1_000_000_000
  it('first sight forces a clear (a fresh process is a rewrite anyway)', () => {
    expect(decideTrigger(undefined, now, 's1', comp(0), DEFAULT_POLICY)).toEqual({ trigger: FORCE_CLEAR_TRIGGER, reason: 'force-first' })
  })
  it('a warm run with a cleared set is held just under the last original so the API keeps reusing it', () => {
    const st = { retained: 200_000, cleared: 300_000, chars: 500_000 * 3.7, lastAt: now - 60_000, spawn: 's1', holds: 0, reclears: 0 }
    expect(decideTrigger(st, now, 's1', comp(300_000 * 3.7), DEFAULT_POLICY)).toEqual({ trigger: 485_000, reason: 'hold' })
    // a respawn inside the cache window keeps holding: a live cache reuses the set, a dead one re-clears for free
    expect(decideTrigger(st, now, 's2', comp(300_000 * 3.7), DEFAULT_POLICY).reason).toBe('hold')
    // small clears keep at least 1k below the original
    expect(decideTrigger({ ...st, cleared: 5_000 }, now, 's1', comp(5_000 * 3.7), DEFAULT_POLICY)).toEqual({ trigger: 204_000, reason: 'hold' })
    // once the stale pile since the clear is worth a rewrite, force one
    expect(decideTrigger(st, now, 's1', comp(500_000 * 3.7), DEFAULT_POLICY)).toEqual({ trigger: FORCE_CLEAR_TRIGGER, reason: 'refresh' })
    expect(decideTrigger(st, now, 's1', comp(500_000 * 3.7), { ...DEFAULT_POLICY, enterAbove: 0 }).reason).toBe('hold')
  })
  it('backs off to no edits when the API keeps re-clearing under hold', () => {
    const st = { retained: 200_000, cleared: 300_000, chars: 500_000 * 3.7, lastAt: now - 60_000, spawn: 's1', holds: 5, reclears: 3 }
    expect(decideTrigger(st, now, 's1', comp(300_000 * 3.7), DEFAULT_POLICY)).toEqual({ trigger: NO_CLEAR_TRIGGER, reason: 'backoff' })
    expect(decideTrigger({ ...st, holds: 20 }, now, 's1', comp(300_000 * 3.7), DEFAULT_POLICY).reason).toBe('hold')
    expect(decideTrigger({ ...st, holds: 2, reclears: 2 }, now, 's1', comp(300_000 * 3.7), DEFAULT_POLICY).reason).toBe('hold')
    // a cold moment resets the regime
    expect(decideTrigger({ ...st, lastAt: now - 56 * 60_000 }, now, 's1', comp(0), DEFAULT_POLICY).reason).toBe('force-cold')
  })
  it('a gap past the TTL forces a clear', () => {
    const st = { retained: 200_000, cleared: 300_000, chars: 0, lastAt: now - 56 * 60_000, spawn: 's1', holds: 0, reclears: 0 }
    expect(decideTrigger(st, now, 's1', comp(0), DEFAULT_POLICY)).toEqual({ trigger: FORCE_CLEAR_TRIGGER, reason: 'force-cold' })
  })
  it('nothing cleared yet: wait for a cold moment unless the stale share is worth a deliberate clear', () => {
    const st = { retained: 120_000, cleared: 0, chars: 120_000 * 3.7, lastAt: now - 1000, spawn: 's1', holds: 0, reclears: 0 }
    expect(decideTrigger(st, now, 's1', comp(50_000 * 3.7), DEFAULT_POLICY)).toEqual({ trigger: NO_CLEAR_TRIGGER, reason: 'none' })
    expect(decideTrigger(st, now, 's1', comp(200_000 * 3.7), DEFAULT_POLICY)).toEqual({ trigger: FORCE_CLEAR_TRIGGER, reason: 'enter' })
    expect(decideTrigger(st, now, 's1', comp(200_000 * 3.7), { ...DEFAULT_POLICY, enterAbove: 0 }).reason).toBe('none')
    // a new process with nothing cleared is a rewrite anyway — clear now
    expect(decideTrigger(st, now, 's2', comp(0), DEFAULT_POLICY).reason).toBe('force-cold')
  })
})

describe('conversationKey', () => {
  it('separates a subagent prompt from its parent under the same session', () => {
    const a = conversationKey('s', { system: [{ type: 'text', text: 'parent prompt' }], messages: [{ role: 'user', content: 'hi' }] })
    const b = conversationKey('s', { system: [{ type: 'text', text: 'subagent prompt' }], messages: [{ role: 'user', content: 'hi' }] })
    const a2 = conversationKey('s', { system: [{ type: 'text', text: 'parent prompt' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'more' }] })
    expect(a).not.toBe(b)
    expect(a).toBe(a2)
  })
})

/** Encode one eventstream frame the way Bedrock does (CRCs are not checked by the parser). */
function frame(headers: Record<string, string>, payload: Buffer): Buffer {
  const hb: Buffer[] = []
  for (const [k, v] of Object.entries(headers)) {
    const kb = Buffer.from(k), vb = Buffer.from(v)
    const len = Buffer.alloc(2); len.writeUInt16BE(vb.length)
    hb.push(Buffer.from([kb.length]), kb, Buffer.from([7]), len, vb)
  }
  const h = Buffer.concat(hb)
  const total = 12 + h.length + payload.length + 4
  const prelude = Buffer.alloc(12); prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(h.length, 4)
  return Buffer.concat([prelude, h, payload, Buffer.alloc(4)])
}
function chunk(ev: Record<string, unknown>): Buffer {
  return frame({ ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(ev)).toString('base64') })))
}

describe('EventStreamParser', () => {
  it('folds usage and applied edits out of frames split across arbitrary chunks', () => {
    const stream = Buffer.concat([
      chunk({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 } } } }),
      chunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
      chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 }, context_management: { applied_edits: [{ type: CLEAR_EDIT_TYPE, cleared_tool_uses: 9, cleared_input_tokens: 10872 }] } }),
    ])
    const p = new EventStreamParser()
    for (let i = 0; i < stream.length; i += 7) p.feed(stream.subarray(i, i + 7))
    expect(p.events).toBe(3)
    expect(p.usage).toEqual({ model: 'claude-x', input: 5, cacheRead: 1000, cacheWrite: 200, cacheWrite1h: 200, cacheWrite5m: 0, output: 7, stopReason: 'end_turn',
      appliedEdits: [{ type: CLEAR_EDIT_TYPE, cleared_tool_uses: 9, cleared_input_tokens: 10872 }] })
  })
  it('records exceptions', () => {
    const p = new EventStreamParser()
    p.feed(frame({ ':message-type': 'exception', ':exception-type': 'validationException' }, Buffer.from('{"message":"bad beta"}')))
    expect(p.usage.exception).toContain('validationException')
  })
})

describe('ContextProxy end to end', () => {
  let upstream: Server | null = null
  let proxy: ContextProxy | null = null
  let dir: string
  afterEach(() => { upstream?.close(); proxy?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('signs, strips its own headers, injects for clear sessions, streams the reply and learns from it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctxproxy-'))
    const cfgPath = join(dir, 'context-proxy.json')
    writeFileSync(cfgPath, JSON.stringify({ enabled: true, sessions: { canary: 'clear', watcher: 'log' } }))
    const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; path: string }> = []
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
        seen.push({ headers: req.headers, body, path: req.url ?? '' })
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
        res.write(chunk({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000 } } }))
        res.end(chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 }, context_management: { applied_edits: [{ type: CLEAR_EDIT_TYPE, cleared_tool_uses: 5, cleared_input_tokens: 30_000 }] } }))
      })
    })
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r))
    const upPort = (upstream.address() as { port: number }).port
    proxy = new ContextProxy({
      region: 'us-east-1', profile: 'none', config: new ProxyConfigStore(cfgPath), logPath: join(dir, 'ledger.jsonl'),
      upstream: { protocol: 'http:', host: '127.0.0.1', port: upPort },
    })
    // static creds via env so no ~/.aws is needed
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE'; process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    const port = await proxy.listen(0)

    const send = (session: string, body: Record<string, unknown>) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body))
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A1%3Aapplication-inference-profile%2Fx/invoke-with-response-stream',
        headers: { 'content-type': 'application/json', 'content-length': data.length, [SESSION_HEADER]: session, [SPAWN_HEADER]: 'sp1', 'anthropic-beta': 'x' } }, (res) => {
        const out: Buffer[] = []
        res.on('data', (c: Buffer) => out.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(out) }))
      })
      req.on('error', reject)
      req.end(data)
    })

    const r1 = await send('canary', toolBody(6))
    expect(r1.status).toBe(200)
    expect(r1.body.length).toBeGreaterThan(50)              // the eventstream came back verbatim
    const u1 = seen[0]
    expect(u1.path).toContain('/model/arn%3Aaws')
    expect(String(u1.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=.*host.*, Signature=[0-9a-f]{64}$/)
    expect(u1.headers[SESSION_HEADER]).toBeUndefined()
    expect(u1.headers[SPAWN_HEADER]).toBeUndefined()
    expect(u1.headers.host).toBe('127.0.0.1')
    const edits1 = (u1.body.context_management as { edits: Array<Record<string, unknown>> }).edits
    expect(edits1.map((e) => e.type)).toEqual(['clear_thinking_20251015', CLEAR_EDIT_TYPE])
    expect(edits1[1].trigger).toEqual({ type: 'input_tokens', value: FORCE_CLEAR_TRIGGER })   // first sight → force
    expect(u1.body.anthropic_beta).toEqual(['x-1', CONTEXT_BETA])

    // second request of the same conversation: the proxy learned retained=20,001 / cleared=30,000 → hold under 50,001
    const r2 = await send('canary', toolBody(7))
    expect(r2.status).toBe(200)
    const edits2 = (seen[1].body.context_management as { edits: Array<Record<string, unknown>> }).edits
    expect(edits2[1].trigger).toEqual({ type: 'input_tokens', value: 50_001 - 1_500 })

    // a log-mode session is forwarded untouched
    await send('watcher', toolBody(6))
    const edits3 = (seen[2].body.context_management as { edits: Array<Record<string, unknown>> }).edits
    expect(edits3.map((e) => e.type)).toEqual(['clear_thinking_20251015'])
    expect(seen[2].body.anthropic_beta).toEqual(['x-1'])

    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(ledger).toHaveLength(3)
    expect(ledger[0]).toMatchObject({ session: 'canary', mode: 'clear', injected: true, reason: 'force-first', status: 200 })
    expect((ledger[0].usage as Record<string, unknown>).cacheWrite).toBe(20_000)
    expect((ledger[0].comp as Composition).stale.n).toBe(0)        // keep=10 > 6 tool uses
    expect(ledger[1]).toMatchObject({ reason: 'hold', trigger: 48_501 })
    expect(ledger[2]).toMatchObject({ session: 'watcher', mode: 'log', injected: false })
    expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(true)
  })

  it('config: disabled or unlisted sessions get no routing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ctxproxy-'))
    const cfgPath = join(dir, 'context-proxy.json')
    const store = new ProxyConfigStore(cfgPath)
    expect(store.modeFor('canary', 'id1')).toBeNull()
    writeFileSync(cfgPath, JSON.stringify({ enabled: false, sessions: { canary: 'clear' } }))
    expect(store.modeFor('canary', 'id1')).toBeNull()
    writeFileSync(cfgPath, JSON.stringify({ enabled: true, sessions: { canary: 'clear', id9: 'log' }, policy: { keep: 4 } }))
    // mtime granularity: force a re-read by bumping the file
    expect(store.modeFor('canary', 'id1')).toBe('clear')
    expect(store.modeFor('other', 'id9')).toBe('log')
    expect(store.modeFor('other', 'id1')).toBeNull()
    expect(store.get().policy).toMatchObject({ keep: 4, clearInputs: false, enterAbove: 150_000 })
    writeFileSync(cfgPath, JSON.stringify({ enabled: true, sessions: { '*': 'log' } }))
    expect(store.modeFor('anyone', 'x')).toBe('log')
  })
})
