import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMultipart, buildMultipart, multipartBoundary } from '../ring/multipart.js'
import { normalise, routeByRules, agentTokens, matchAgentPrefix, describeCommand, type RingAgent } from '../ring/router.js'
import { parseClassifyReply, buildClassifyPrompt } from '../ring/llm-fallback.js'
import { RingStore } from '../ring/store.js'
import { processDelivery, buildRingEnvelope, type RingCtx } from '../ring/pipeline.js'
import { deliveryFromRequest } from '../routes/ring.js'

const AGENTS: RingAgent[] = [
  { id: 's1', name: 'Console general', agentKey: 'console-general' },
  { id: 's2', name: 'Al', agentKey: 'al' },
  { id: 's3', name: 'Astera general', agentKey: 'astera-general' },
  { id: 's4', name: 'Astera admin (fork)', agentKey: 'astera-general-fork-2', fork: true },
  { id: 's5', name: 'Home', agentKey: 'home' },
]

describe('multipart', () => {
  it('round-trips text + binary parts byte-exactly', () => {
    const audio = Buffer.from([0x00, 0x0d, 0x0a, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0x00])
    const { body, contentType } = buildMultipart([
      { name: 'transcription', value: 'tell al hello' },
      { name: 'recordedAt', value: '1756800000000' },
      { name: 'client', value: 'ring' },
      { name: 'audio', value: audio, filename: 'rec.m4a', contentType: 'audio/mp4' },
    ], 'B0UNDARY')
    const boundary = multipartBoundary(contentType)
    expect(boundary).toBe('B0UNDARY')
    const parts = parseMultipart(body, boundary!)
    expect(parts.map((p) => p.name)).toEqual(['transcription', 'recordedAt', 'client', 'audio'])
    expect(parts[0]!.data.toString()).toBe('tell al hello')
    expect(parts[3]!.filename).toBe('rec.m4a')
    expect(parts[3]!.contentType).toBe('audio/mp4')
    expect(Buffer.compare(parts[3]!.data, audio)).toBe(0)
  })

  it('handles a quoted boundary and empty parts', () => {
    expect(multipartBoundary('multipart/form-data; boundary="abc-123"')).toBe('abc-123')
    const { body } = buildMultipart([{ name: 'transcription', value: '' }], 'x')
    const parts = parseMultipart(body, 'x')
    expect(parts).toHaveLength(1)
    expect(parts[0]!.data.length).toBe(0)
  })
})

describe('normalise', () => {
  it('lowercases, strips fillers and trailing punctuation', () => {
    expect(normalise('  Hey, please tell Al: I’m late!! ')).toBe("tell al: i'm late")
    expect(normalise('Okay so, Pause the music.')).toBe('pause the music')
  })
  it('does not strip a leading agent name that looks like filler', () => {
    expect(normalise('Console general, look at the board')).toBe('console general, look at the board')
  })
})

describe('agentTokens / matchAgentPrefix', () => {
  it('prefers the longest token, then full name over key over alias over first word', () => {
    const tokens = agentTokens(AGENTS)
    for (let i = 1; i < tokens.length; i++) expect(tokens[i - 1]!.token.length).toBeGreaterThanOrEqual(tokens[i]!.token.length)
    expect(matchAgentPrefix('console general fix it', tokens)?.agent.id).toBe('s1')
    expect(matchAgentPrefix('console fix it', tokens)?.agent.id).toBe('s1')
    expect(matchAgentPrefix('owl, what time is it', tokens)).toMatchObject({ agent: { id: 's2' }, rest: 'what time is it' })
  })
  it('never lets a fork claim the shared first word', () => {
    const tokens = agentTokens(AGENTS)
    expect(matchAgentPrefix('astera check invoices', tokens)?.agent.id).toBe('s3')
    expect(matchAgentPrefix('astera admin check invoices', tokens)?.agent.id).toBe('s4')
  })
  it('requires a word boundary after the token', () => {
    const tokens = agentTokens(AGENTS)
    expect(matchAgentPrefix('all good here', tokens)).toBeNull()
    expect(matchAgentPrefix('homework is due', tokens)).toBeNull()
  })
})

describe('routeByRules', () => {
  it('verb-first addressing strips the addressing words', () => {
    expect(routeByRules('Tell Al to buy milk', AGENTS)).toMatchObject({ rule: 'agent.verb', command: { kind: 'agent', targetId: 's2', message: 'buy milk' } })
    expect(routeByRules('ask console general what the board says', AGENTS)).toMatchObject({ command: { targetId: 's1', message: 'what the board says' } })
    expect(routeByRules('message astera that the invoice is paid', AGENTS)).toMatchObject({ command: { targetId: 's3', message: 'the invoice is paid' } })
  })
  it('name-first addressing', () => {
    expect(routeByRules('Console, restart the dev server', AGENTS)).toMatchObject({ rule: 'agent.direct', command: { targetId: 's1', message: 'restart the dev server' } })
    expect(routeByRules('Hal what is the weather', AGENTS)).toMatchObject({ command: { targetId: 's2', message: 'what is the weather' } })
  })
  it('a bare agent name with no message is not a command', () => {
    expect(routeByRules('Al', AGENTS)).toBeNull()
  })
  it('music transport', () => {
    expect(routeByRules('pause the music', AGENTS)).toMatchObject({ rule: 'music.pause', command: { kind: 'music', action: 'pause' } })
    expect(routeByRules('Skip.', AGENTS)).toMatchObject({ command: { action: 'next' } })
    expect(routeByRules('go back', AGENTS)).toMatchObject({ command: { action: 'previous' } })
    expect(routeByRules('play', AGENTS)).toMatchObject({ rule: 'music.play', command: { action: 'play' } })
    expect(routeByRules('play some Radiohead', AGENTS)).toMatchObject({ rule: 'music.play-query', command: { action: 'play', query: 'radiohead' } })
  })
  it('returns null for anything else', () => {
    expect(routeByRules('remind me to water the plants', AGENTS)).toBeNull()
    expect(routeByRules('', AGENTS)).toBeNull()
  })
  it('describeCommand is a one-liner per kind', () => {
    expect(describeCommand({ kind: 'music', action: 'play', query: 'x' })).toBe('music play "x"')
    expect(describeCommand({ kind: 'agent', targetId: 's2', targetName: 'Al', message: 'hi' })).toBe('→ Al: hi')
  })
})

describe('llm fallback parsing', () => {
  it('accepts only on-schema replies with a known agent id', () => {
    expect(parseClassifyReply('Sure! {"kind":"agent","targetId":"s2","message":"buy milk"}', AGENTS, 'x')).toMatchObject({ kind: 'agent', targetId: 's2', targetName: 'Al', message: 'buy milk' })
    expect(parseClassifyReply('{"kind":"agent","targetId":"nope","message":"x"}', AGENTS, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"music","action":"louder"}', AGENTS, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"music","action":"next"}', AGENTS, 'x')).toEqual({ kind: 'music', action: 'next' })
    expect(parseClassifyReply('{"kind":"unknown"}', AGENTS, 'raw')).toEqual({ kind: 'unknown', text: 'raw' })
    expect(parseClassifyReply('I cannot help', AGENTS, 'x')).toBeNull()
  })
  it('prompt carries the roster and the transcript verbatim', () => {
    const p = buildClassifyPrompt('tel owl buy "milk"', AGENTS)
    expect(p).toContain('id=s2 name="Al" key=al')
    expect(p).toContain(JSON.stringify('tel owl buy "milk"'))
  })
})

describe('RingStore + pipeline', () => {
  let dir: string
  let store: RingStore
  let injected: Array<{ id: string; content: string }>
  let notified: Array<{ title: string; body: string }>
  let music: string[]
  let ctx: RingCtx

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ring-'))
    store = new RingStore(dir)
    injected = []; notified = []; music = []
    ctx = {
      store,
      agents: () => AGENTS,
      sessionForKey: (k) => AGENTS.find((a) => a.agentKey === k) ?? null,
      inject: (id, content) => { if (id === 's5') return false; injected.push({ id, content }); return true },
      music: {
        play: async (q) => { music.push(`play:${q ?? ''}`); return 'ok' },
        pause: async () => { music.push('pause'); return 'ok' },
        next: async () => { music.push('next'); return 'ok' },
        previous: async () => { music.push('prev'); return 'ok' },
      },
      transcribe: async () => 'tell al from stt',
      classify: async (text) => text.includes('skip please') ? { kind: 'music', action: 'next' } : null,
      notify: (m) => notified.push({ title: m.title, body: m.body }),
      log: () => {},
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('archives audio + sidecar and routes a ruled command', async () => {
    const audio = Buffer.from('fake-m4a-bytes')
    const rec = await processDelivery(ctx, { transcription: 'tell al buy milk', audio: { data: audio, contentType: 'audio/mp4' }, recordedAt: 1756800000000, client: 'ring' })
    expect(rec.audio?.bytes).toBe(audio.length)
    expect(existsSync(rec.audio!.path)).toBe(true)
    expect(rec.audio!.path.endsWith('.m4a')).toBe(true)
    expect(rec.transcriptionSource).toBe('ring')
    expect(rec.route).toMatchObject({ via: 'rule', rule: 'agent.verb', ok: true, command: { kind: 'agent', targetId: 's2' } })
    expect(injected[0]).toMatchObject({ id: 's2' })
    expect(injected[0]!.content).toBe(buildRingEnvelope('buy milk', rec.id))
    expect(injected[0]!.content).toMatch(/^\[RING — voice command/)
    expect(notified[0]).toMatchObject({ title: 'Ring → Al', body: 'buy milk' })
    // Sidecar on disk carries the routing outcome.
    const sidecar = JSON.parse(readFileSync(join(dir, 'ring', 'recordings', `${rec.id}.json`), 'utf8'))
    expect(sidecar.route.ok).toBe(true)
    expect(store.list()[0]!.id).toBe(rec.id)
    expect(store.count()).toBe(1)
  })

  it('falls back to hub STT when the ring sent no transcript', async () => {
    const rec = await processDelivery(ctx, { transcription: null, audio: { data: Buffer.from('x'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    expect(rec.transcription).toBe('tell al from stt')
    expect(rec.transcriptionSource).toBe('hub-stt')
    expect(rec.route?.command).toMatchObject({ kind: 'agent', targetId: 's2', message: 'from stt' })
  })

  it('consults the LLM only when rules miss, then the fallback agent, then unknown', async () => {
    const llm = await processDelivery(ctx, { transcription: 'uh skip please', audio: null, recordedAt: null, client: 'simulated' })
    expect(llm.route).toMatchObject({ via: 'llm', command: { kind: 'music', action: 'next' } })
    expect(music).toEqual(['next'])

    const fb = await processDelivery(ctx, { transcription: 'remind me to water the plants', audio: null, recordedAt: null, client: 'simulated' })
    expect(fb.route).toMatchObject({ via: 'default', ok: true, command: { kind: 'agent', targetId: 's2', message: 'remind me to water the plants' } })

    store.setConfig({ fallbackAgent: null, llmFallback: false })
    const none = await processDelivery(ctx, { transcription: 'remind me to water the plants', audio: null, recordedAt: null, client: 'simulated' })
    expect(none.route).toMatchObject({ via: 'none', ok: false, command: { kind: 'unknown' } })
    expect(notified.at(-1)!.title).toBe('Ring: not delivered')
  })

  it('reports a dead target instead of pretending', async () => {
    const rec = await processDelivery(ctx, { transcription: 'tell home the boiler is off', audio: null, recordedAt: null, client: 'simulated' })
    expect(rec.route).toMatchObject({ ok: false, detail: 'Home is not live' })
  })

  it('an untranscribable delivery is still archived', async () => {
    ctx.transcribe = async () => null
    const rec = await processDelivery(ctx, { transcription: null, audio: { data: Buffer.from('x'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    expect(rec.route).toBeUndefined()
    expect(rec.audio).not.toBeNull()
    expect(notified[0]!.title).toBe('Ring: no transcript')
  })

  it('config merges defaults', () => {
    expect(store.config()).toEqual({ fallbackAgent: 'al', llmFallback: true })
    expect(store.setConfig({ fallbackAgent: 'console-general' })).toEqual({ fallbackAgent: 'console-general', llmFallback: true })
  })

  it('rejects path-ish ids', () => {
    expect(store.get('../x')).toBeNull()
    expect(store.audioPath('../../etc/passwd')).toBeNull()
  })
})

describe('deliveryFromRequest', () => {
  it('parses the ring multipart shape', () => {
    const { body, contentType } = buildMultipart([
      { name: 'audio', value: Buffer.from('m4a'), filename: 'r.m4a', contentType: 'audio/mp4' },
      { name: 'transcription', value: 'pause' },
      { name: 'recordedAt', value: '1756800000000' },
      { name: 'client', value: 'ring' },
    ])
    expect(deliveryFromRequest(contentType, body)).toMatchObject({ transcription: 'pause', recordedAt: 1756800000000, client: 'ring', audio: { contentType: 'audio/mp4' } })
  })
  it('a missing transcription part yields null, not empty string', () => {
    const { body, contentType } = buildMultipart([{ name: 'audio', value: Buffer.from('m4a'), filename: 'r.m4a', contentType: 'audio/mp4' }, { name: 'client', value: 'ring' }])
    expect(deliveryFromRequest(contentType, body).transcription).toBeNull()
  })
  it('accepts JSON for the simulator', () => {
    expect(deliveryFromRequest('application/json', Buffer.from(JSON.stringify({ text: 'next' })))).toMatchObject({ transcription: 'next', audio: null, client: 'simulated' })
  })
})
