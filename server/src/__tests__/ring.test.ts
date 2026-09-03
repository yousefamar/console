import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMultipart, buildMultipart, multipartBoundary } from '../ring/multipart.js'
import { normalise, routeByRules, describeCommand, editDistance, fuzzyEqual, pickFuzzy, matchVerb, type RingAgent, type RouteEnv } from '../ring/router.js'
import { parseClassifyReply, buildClassifyPrompt, parseMovieReply } from '../ring/llm-fallback.js'
import { parseSchemaNote, seedSchemaNote, DEFAULT_SCHEMA, describeSchema, type RingSchema } from '../ring/schema.js'
import { RingSchemaLoader } from '../ring/schema-loader.js'
import { appendLogEntry, appendBullet, appendMovieRow } from '../ring/append.js'
import { RingStore } from '../ring/store.js'
import { processDelivery, buildRingEnvelope, buildRelayEnvelope, type RingCtx } from '../ring/pipeline.js'
import { deliveryFromRequest } from '../routes/ring.js'
import { NoteStore } from '../notes.js'

const AGENTS: RingAgent[] = [
  { id: 's1', name: 'Console general', agentKey: 'console-general' },
  { id: 's2', name: 'AL', agentKey: 'al' },
]
const ENV: RouteEnv = { projects: ['console', 'astera', 'reflection-tools'], contacts: ['nica', 'sam-miller', 'yasmina-amar'] }
const SCHEMA: RingSchema = parseSchemaNote(seedSchemaNote()).schema
SCHEMA.verbs.message.contacts = { mum: 'yasmina-amar', nica: 'nica' }

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
    expect(parseMultipart(body, 'x')).toHaveLength(1)
  })
})

describe('normalise + fuzzy', () => {
  it('lowercases, strips fillers and trailing punctuation', () => {
    expect(normalise('  Hey, please tell Al: I’m late!! ')).toBe("tell al: i'm late")
    expect(normalise('Okay so, Pause the music.')).toBe('pause the music')
  })
  it('editDistance / fuzzyEqual / pickFuzzy', () => {
    expect(editDistance('movies', 'moves')).toBe(1)
    expect(editDistance('log', 'lock')).toBe(2)
    expect(fuzzyEqual('moves', 'movies')).toBe(true)
    expect(fuzzyEqual('log', 'lock')).toBe(false) // <4 letters → exact only
    expect(fuzzyEqual('dreem', 'dream')).toBe(true)
    expect(pickFuzzy('gaems', ['games', 'gamer'])).toBeNull() // ambiguous → never guess
    expect(pickFuzzy('games', ['games', 'gamer'])).toBe('games')
  })
  it('matchVerb: name, alias, one edit — never between two verbs', () => {
    expect(matchVerb('log', SCHEMA)).toBe('log')
    expect(matchVerb('lock', SCHEMA)).toBe('log') // schema alias
    expect(matchVerb('massage', SCHEMA)).toBe('message')
    expect(matchVerb('tell', SCHEMA)).toBe('message')
    expect(matchVerb('banana', SCHEMA)).toBeNull()
  })
})

describe('schema note', () => {
  it('the seed parses cleanly and matches the defaults where it should', () => {
    const p = parseSchemaNote(seedSchemaNote())
    expect(p.found).toBe(true)
    expect(p.errors).toEqual([])
    expect(p.schema.fallback).toBe('al')
    expect(p.schema.verbs.add.targets.movies).toEqual({ file: 'scratch/lists/movie-list.md', enrich: 'movie' })
    expect(p.schema.verbs.add.targets.reading).toEqual({ file: 'scratch/lists/reading-list.md' })
    expect(p.schema.verbs.log.aliases).toContain('lock')
  })
  it('missing fence → defaults + found:false; bad yaml → error', () => {
    expect(parseSchemaNote('# nothing here')).toMatchObject({ found: false, schema: DEFAULT_SCHEMA })
    const bad = parseSchemaNote('```yaml\nverbs: [\n```')
    expect(bad.found).toBe(true)
    expect(bad.errors[0]).toMatch(/^yaml/)
  })
  it('validates shapes and unknown verbs/enrichers without dropping the rest', () => {
    const p = parseSchemaNote('```yaml\nfallback: null\nverbs:\n  add:\n    targets:\n      films: { file: x.md, enrich: imdb }\n      books: 12\n  dance: {}\n```')
    expect(p.schema.fallback).toBeNull()
    expect(p.schema.verbs.add.targets.films).toEqual({ file: 'x.md' })
    expect(p.schema.verbs.add.targets.books).toBeUndefined()
    expect(p.errors.join('\n')).toMatch(/enrich: unknown enricher "imdb"/)
    expect(p.errors.join('\n')).toMatch(/books: expected a file path/)
    expect(p.errors.join('\n')).toMatch(/verbs.dance: unknown verb/)
  })
})

describe('routeByRules (schema-driven tree)', () => {
  const r = (t: string) => routeByRules(t, SCHEMA, ENV)
  it('log <name> <text>, with STT punctuation and a fuzzy target', () => {
    expect(r('Log dream. I was escaping a prison made of cheese')).toMatchObject({ rule: 'log', command: { kind: 'log', target: 'dream', file: 'scratch/logs/dream.md', text: 'I was escaping a prison made of cheese' } })
    expect(r('lock dreem it was dark')).toMatchObject({ command: { kind: 'log', target: 'dream' } })
    expect(r('log food two eggs')).toMatchObject({ rule: 'log.unknown-target', command: { kind: 'unknown-target', verb: 'log', target: 'food' } })
  })
  it('add <list> <item> and add <project> <text>', () => {
    expect(r('Add movies Spiderman')).toMatchObject({ rule: 'add.list', command: { kind: 'list', target: 'movies', item: 'Spiderman', enrich: 'movie' } })
    expect(r('ad groceries eggs')).toMatchObject({ command: { kind: 'list', target: 'groceries', item: 'eggs' } })
    expect(r('add console the login button is misaligned')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'console', column: 'Backlog', text: 'the login button is misaligned' } })
    expect(r('add reflection tools export to csv')).toMatchObject({ command: { kind: 'card', project: 'reflection-tools', text: 'export to csv' } })
    expect(r('add nonsense thing')).toMatchObject({ command: { kind: 'unknown-target', verb: 'add', target: 'nonsense' } })
  })
  it('message <person> <text> via nickname or username', () => {
    expect(r("Message mum I'll be home in 30 mins")).toMatchObject({ rule: 'message.nickname', command: { kind: 'message', contact: 'yasmina-amar', spoken: 'mum', text: "I'll be home in 30 mins" } })
    expect(r('text nica running late')).toMatchObject({ rule: 'message.nickname', command: { kind: 'message', contact: 'nica' } })
    expect(r('message sam-miller hi')).toMatchObject({ rule: 'message.contact', command: { contact: 'sam-miller' } })
    expect(r('message stranger hi')).toMatchObject({ command: { kind: 'unknown-target', verb: 'message' } })
  })
  it('there is no agent verb — "tell" is a message alias, bare names are unclaimed', () => {
    expect(r("tell mum I'm late")).toMatchObject({ rule: 'message.nickname', command: { kind: 'message', contact: 'yasmina-amar', text: "I'm late" } })
    expect(r('agent console fix the build')).toBeNull()
    expect(r('Console, restart the dev server')).toBeNull()
    expect(r('ask owl what time is it')).toBeNull()
  })
  it('music transport + play query', () => {
    expect(r('pause the music')).toMatchObject({ rule: 'music.pause' })
    expect(r('Skip.')).toMatchObject({ command: { action: 'next' } })
    expect(r('play')).toMatchObject({ rule: 'music.play' })
    expect(r('play some Radiohead')).toMatchObject({ rule: 'music.play-query', command: { query: 'Radiohead' } })
  })
  it('unmatched → null (caller decides LLM / fallback)', () => {
    expect(r('remind me to water the plants')).toBeNull()
    expect(r('Al')).toBeNull()
    expect(r('')).toBeNull()
  })
  it('describeCommand covers every kind', () => {
    expect(describeCommand({ kind: 'card', project: 'console', column: 'Backlog', text: 'x' })).toBe('card → console (Backlog): x')
    expect(describeCommand({ kind: 'unknown-target', verb: 'log', target: 'food', text: 'x' })).toBe('log: no target called "food"')
  })
})

describe('llm fallback parsing', () => {
  it('accepts only on-schema replies with known targets', () => {
    expect(parseClassifyReply('{"kind":"agent","targetId":"s2","message":"buy milk"}', SCHEMA, ENV, 'x')).toBeNull() // no agent verb
    expect(parseClassifyReply('{"kind":"log","target":"dream","text":"flying"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'log', file: 'scratch/logs/dream.md' })
    expect(parseClassifyReply('{"kind":"log","target":"food","text":"eggs"}', SCHEMA, ENV, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"list","target":"movies","item":"Dune"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'list', enrich: 'movie' })
    expect(parseClassifyReply('{"kind":"card","project":"console","text":"fix"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'card', column: 'Backlog' })
    expect(parseClassifyReply('{"kind":"card","project":"nope","text":"fix"}', SCHEMA, ENV, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"message","contact":"nica","text":"hi"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'message', contact: 'nica' })
    expect(parseClassifyReply('{"kind":"music","action":"louder"}', SCHEMA, ENV, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"unknown"}', SCHEMA, ENV, 'raw')).toEqual({ kind: 'unknown', text: 'raw' })
    expect(parseClassifyReply('I cannot help', SCHEMA, ENV, 'x')).toBeNull()
  })
  it('prompt carries the tree, roster and transcript verbatim', () => {
    const p = buildClassifyPrompt('tel owl buy "milk"', SCHEMA, ENV)
    expect(p).not.toContain('"agent"')
    expect(p).toContain('one of: dream')
    expect(p).toContain('mum→yasmina-amar')
    expect(p).toContain(JSON.stringify('tel owl buy "milk"'))
  })
  it('movie reply parsing falls back to the spoken title', () => {
    expect(parseMovieReply('{"title":"Spider-Man","year":2002,"series":"No"}', 'spiderman')).toEqual({ title: 'Spider-Man', year: '2002', series: 'No' })
    expect(parseMovieReply('{"series":"Yes (Netflix)"}', 'thing')).toEqual({ title: 'thing', year: '', series: 'Yes (Netflix)' })
    expect(parseMovieReply('nope', 'x')).toBeNull()
  })
})

describe('append helpers', () => {
  const at = new Date(2026, 8, 2, 23, 7) // local 23:07
  it('log: one heading per day, bullets beneath', () => {
    const first = appendLogEntry(null, 'cheese prison', at)
    expect(first).toBe('## 2026-09-02\n- 23:07 cheese prison\n')
    const second = appendLogEntry(first, 'again', at)
    expect(second).toBe('## 2026-09-02\n- 23:07 cheese prison\n- 23:07 again\n')
    const next = appendLogEntry(second, 'tomorrow', new Date(2026, 8, 3, 8, 0))
    expect(next.endsWith('\n\n## 2026-09-03\n- 08:00 tomorrow\n')).toBe(true)
  })
  it('bullet append keeps existing content', () => {
    expect(appendBullet('- a\n- b\n\n', 'c')).toBe('- a\n- b\n- c\n')
    expect(appendBullet(null, 'c')).toBe('- c\n')
  })
  it('movie row: drops the trailing blank row, pads to the header, escapes pipes', () => {
    const table = '- misc\n\n| Title      | Year | Series | Watched |\n| ---------- | ---- | ------ | ------- |\n| Vivarium   | 2019 | No     | Yes     |\n|            |      |        |         |\n'
    const out = appendMovieRow(table, { title: 'Dune | Part Two', year: '2024', series: 'No' })
    const lines = out.trimEnd().split('\n')
    expect(lines.at(-1)).toBe('| Dune / Part Two | 2024 | No     | No      |')
    expect(lines.at(-2)).toBe('| Vivarium   | 2019 | No     | Yes     |')
    expect(appendMovieRow('- just bullets\n', { title: 'X', year: '1999', series: 'No' })).toBe('- just bullets\n- X (1999)\n')
  })
})

describe('RingSchemaLoader', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ring-vault-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('seeds a missing note, hot-reloads edits, keeps last good on a broken edit', async () => {
    const store = new NoteStore(dir, join(dir, 'tomb.json'))
    const loader = new RingSchemaLoader(store, () => {}, 'ring-schema.md')
    const first = await loader.load()
    expect(first.stale).toBe(false)
    expect(existsSync(join(dir, 'ring-schema.md'))).toBe(true)
    writeFileSync(join(dir, 'ring-schema.md'), '```yaml\nfallback: console-general\n```')
    expect((await loader.load()).schema.fallback).toBe('console-general')
    writeFileSync(join(dir, 'ring-schema.md'), '```yaml\nverbs: [\n```')
    const broken = await loader.load()
    expect(broken.stale).toBe(true)
    expect(broken.schema.fallback).toBe('console-general')
    expect(broken.errors[0]).toMatch(/^yaml/)
  })
})

describe('describeSchema', () => {
  it('flags contacts/agents that do not resolve, and missing files as create-on-use', async () => {
    const d = await describeSchema({ schema: SCHEMA, errors: [], stale: false, path: 'p.md' }, { ...ENV, agents: AGENTS }, async (p) => p.endsWith('movie-list.md'))
    expect(d.fallback).toEqual({ agentKey: 'al', live: true })
    const add = d.verbs.find((v) => v.verb === 'add')!
    expect(add.targets.find((t) => t.name === 'movies')!.note).toBeUndefined()
    expect(add.targets.find((t) => t.name === 'groceries')!.note).toMatch(/created on first use/)
    expect(add.targets.find((t) => t.name === 'console')!.resolves).toBe('board card → Backlog')
    const msg = d.verbs.find((v) => v.verb === 'message')!
    expect(msg.targets.find((t) => t.name === 'mum')!.ok).toBe(true)
    expect(d.verbs.map((v) => v.verb)).toEqual(['log', 'add', 'message', 'music'])
  })
})

describe('RingStore + pipeline', () => {
  let dir: string
  let store: RingStore
  let injected: Array<{ id: string; content: string }>
  let notified: Array<{ title: string; body: string }>
  let music: string[]
  let notes: Map<string, string>
  let cards: string[]
  let schema: RingSchema
  let ctx: RingCtx

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ring-'))
    store = new RingStore(dir)
    injected = []; notified = []; music = []; cards = []
    notes = new Map()
    schema = structuredClone(SCHEMA)
    ctx = {
      store,
      schema: async () => ({ schema, errors: [] }),
      describeSchema: async () => { throw new Error('unused') },
      env: async () => ENV,
      sessionForKey: (k) => AGENTS.find((a) => a.agentKey === k) ?? null,
      inject: (id, content) => { injected.push({ id, content }); return true },
      notes: { read: async (p) => notes.get(p) ?? null, write: async (p, c) => { notes.set(p, c) } },
      addCard: async (project, text, column) => { cards.push(`${project}/${column}: ${text}`); return `"${text}" → ${column}` },
      music: {
        play: async (q) => { music.push(`play:${q ?? ''}`); return 'ok' },
        pause: async () => { music.push('pause'); return 'ok' },
        next: async () => { music.push('next'); return 'ok' },
        previous: async () => { music.push('prev'); return 'ok' },
      },
      transcribe: async () => 'weather from stt',
      classify: async (text) => text.includes('skip please') ? { kind: 'music', action: 'next' } : null,
      enrichMovie: async (t) => t.toLowerCase() === 'spiderman' ? { title: 'Spider-Man', year: '2002', series: 'No' } : null,
      notify: (m) => notified.push({ title: m.title, body: m.body }),
      now: () => new Date(2026, 8, 2, 23, 7),
      log: () => {},
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const deliver = (transcription: string) => processDelivery(ctx, { transcription, audio: null, recordedAt: null, client: 'simulated' })

  it('archives audio + sidecar; unclaimed text goes to the fallback agent', async () => {
    const audio = Buffer.from('fake-m4a-bytes')
    const rec = await processDelivery(ctx, { transcription: 'What is the weather like', audio: { data: audio, contentType: 'audio/mp4' }, recordedAt: 1756800000000, client: 'ring' })
    expect(rec.audio?.bytes).toBe(audio.length)
    expect(existsSync(rec.audio!.path)).toBe(true)
    expect(rec.transcriptionSource).toBe('ring')
    expect(rec.route).toMatchObject({ via: 'default', ok: true, command: { kind: 'agent', targetId: 's2' } })
    expect(injected[0]!.content).toBe(buildRingEnvelope('What is the weather like', rec.id))
    expect(notified[0]).toMatchObject({ title: 'Ring → AL', body: 'What is the weather like' })
    expect(JSON.parse(readFileSync(join(dir, 'ring', 'recordings', `${rec.id}.json`), 'utf8')).route.ok).toBe(true)
    expect(store.count()).toBe(1)
  })

  it('log appends a dated bullet to the target note', async () => {
    const rec = await deliver('log dream I was escaping a prison made of cheese')
    expect(rec.route).toMatchObject({ rule: 'log', ok: true })
    expect(notes.get('scratch/logs/dream.md')).toBe('## 2026-09-02\n- 23:07 I was escaping a prison made of cheese\n')
    expect(notified[0]).toMatchObject({ title: 'Ring · log dream' })
  })

  it('add <list>: movie enrichment → table row; other lists → bullet; enrichment failure → bullet', async () => {
    notes.set('scratch/lists/movie-list.md', '| Title | Year | Series | Watched |\n| --- | --- | --- | --- |\n')
    await deliver('add movies spiderman')
    expect(notes.get('scratch/lists/movie-list.md')!.trimEnd().split('\n').at(-1)).toBe('| Spider-Man | 2002 | No     | No      |')
    expect(notified.at(-1)).toMatchObject({ body: 'Spider-Man (2002)' })
    await deliver('add groceries eggs')
    expect(notes.get('scratch/lists/groceries.md')).toBe('- eggs\n')
    await deliver('add movies some obscure thing')
    expect(notes.get('scratch/lists/movie-list.md')!.trimEnd().split('\n').at(-1)).toBe('- some obscure thing')
  })

  it('add <project> files a board card', async () => {
    const rec = await deliver('add console the login button is misaligned')
    expect(rec.route).toMatchObject({ rule: 'add.card', ok: true, detail: '"the login button is misaligned" → Backlog' })
    expect(cards).toEqual(['console/Backlog: the login button is misaligned'])
  })

  it('message relays through AL with attribution', async () => {
    const rec = await deliver("message mum I'll be home in 30 mins")
    expect(rec.route).toMatchObject({ rule: 'message.nickname', ok: true })
    expect(injected[0]!.id).toBe('s2')
    expect(injected[0]!.content).toBe(buildRelayEnvelope('yasmina-amar', 'mum', "I'll be home in 30 mins", rec.id))
    expect(injected[0]!.content).toMatch(/attributed to Yousef/)
    expect(notified[0]!.title).toBe('Ring → AL relays to mum')
  })

  it('a verb with an unknown target is actionable feedback, not a fallback', async () => {
    const rec = await deliver('log food two eggs')
    expect(rec.route).toMatchObject({ rule: 'log.unknown-target', ok: false })
    expect(injected).toHaveLength(0)
    expect(notified[0]!.body).toMatch(/no log target called "food"/)
  })

  it('falls back to hub STT when the ring sent no transcript', async () => {
    const rec = await processDelivery(ctx, { transcription: null, audio: { data: Buffer.from('x'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    expect(rec.transcriptionSource).toBe('hub-stt')
    expect(rec.route?.command).toMatchObject({ kind: 'agent', targetId: 's2', message: 'weather from stt' })
  })

  it('LLM only when rules miss, then the fallback agent, then unknown', async () => {
    expect((await deliver('uh skip please')).route).toMatchObject({ via: 'llm', command: { kind: 'music', action: 'next' } })
    expect(music).toEqual(['next'])
    expect((await deliver('remind me to water the plants')).route).toMatchObject({ via: 'default', ok: true, command: { targetId: 's2' } })
    schema.fallback = null; schema.llmFallback = false
    const none = await deliver('remind me to water the plants')
    expect(none.route).toMatchObject({ via: 'none', ok: false, command: { kind: 'unknown' } })
    expect(notified.at(-1)!.title).toBe('Ring: not delivered')
  })

  it('reports a dead fallback instead of pretending', async () => {
    ctx.sessionForKey = () => ({ id: 'dead', name: 'AL', agentKey: 'al' })
    ctx.inject = () => false
    expect((await deliver('what is the weather like')).route).toMatchObject({ via: 'default', ok: false, detail: 'AL is not live' })
  })

  it('an untranscribable delivery is still archived', async () => {
    ctx.transcribe = async () => null
    const rec = await processDelivery(ctx, { transcription: null, audio: { data: Buffer.from('x'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    expect(rec.route).toBeUndefined()
    expect(rec.audio).not.toBeNull()
    expect(notified[0]!.title).toBe('Ring: no transcript')
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
