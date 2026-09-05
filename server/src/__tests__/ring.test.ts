import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMultipart, buildMultipart, multipartBoundary } from '../ring/multipart.js'
import { normalise, routeByRules, describeCommand, editDistance, fuzzyEqual, pickFuzzy, resolveSpoken, matchVerb, matchMusicTransport, type RouteEnv } from '../ring/router.js'
import { parseClassifyReply, buildClassifyPrompt, parseMovieReply } from '../ring/llm-fallback.js'
import { parseSchemaNote, seedSchemaNote, DEFAULT_SCHEMA, describeSchema, spokenForms, contactForms, type RingSchema } from '../ring/schema.js'
import { RingSchemaLoader } from '../ring/schema-loader.js'
import { appendLogEntry, appendBullet, appendMovieRow } from '../ring/append.js'
import { RingStore } from '../ring/store.js'
import { processDelivery, buildFallbackEnvelope, buildRingForkSeed, type RingCtx } from '../ring/pipeline.js'
import { ContactRoomResolver, ghostUserIds, identifierFromGhost } from '../ring/chat-room.js'
import { deliveryFromRequest } from '../routes/ring.js'
import { NoteStore } from '../notes.js'

const AGENTS = [{ agentKey: 'console-general' }, { agentKey: 'al' }]
const ENV: RouteEnv = { projects: ['console', 'astera', 'reflection-tools'], contacts: ['al', 'nica', 'sam-miller', 'yasmina-amar'] }
const SCHEMA: RingSchema = parseSchemaNote(seedSchemaNote()).schema
SCHEMA.verbs.message.contacts = { al: ['owl', 'hal'], 'yasmina-amar': ['mum', 'sister', 'yasmina'], nica: ['nika', 'veronica'] }

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
    expect(editDistance('flims', 'films')).toBe(1) // adjacent swap = one edit
    expect(fuzzyEqual('moves', 'movies')).toBe(true)
    expect(fuzzyEqual('log', 'lock')).toBe(false) // <4 letters → exact only
    expect(fuzzyEqual('dreem', 'dream')).toBe(true)
    expect(pickFuzzy('gamer', ['games', 'gamed'])).toBeNull() // ambiguous → never guess
    expect(pickFuzzy('gaems', ['games', 'gamer'])).toBe('games') // swap = 1 edit, unique
    expect(pickFuzzy('games', ['games', 'gamer'])).toBe('games')
  })
  it('resolveSpoken: alias table, fuzzy on two forms of the SAME canonical is still unique', () => {
    const forms = spokenForms(SCHEMA.verbs.add.targets)
    expect(resolveSpoken('films', forms)).toBe('movies')
    expect(resolveSpoken('flims', forms)).toBe('movies') // one edit off "films"
    expect(resolveSpoken('dreams', forms)).toBe('dream')
    expect(resolveSpoken('system', forms)).toBe('emotion')
    expect(resolveSpoken('banana', forms)).toBeNull()
  })
  it('contactForms: first name of a hyphenated username is automatic when unique', () => {
    const forms = contactForms({ 'yasmina-amar': ['mum'], 'sam-miller': [] }, ['yasmina-amar', 'sam-miller', 'sam-miller-1', 'nica'])
    expect(forms.get('yasmina')).toBe('yasmina-amar')
    expect(forms.get('sam')).toBeUndefined() // sam-miller AND sam-miller-1 both own "sam" → not derived
    expect(forms.get('mum')).toBe('yasmina-amar')
    expect(contactForms({ 'sam-miller': ['sam'] }, ['sam-miller', 'sam-miller-1']).get('sam')).toBe('sam-miller') // explicit wins
  })
  it('matchVerb: name, alias, one edit — never between two verbs', () => {
    expect(matchVerb('log', SCHEMA)).toEqual({ verb: 'add', exact: true }) // log IS add
    expect(matchVerb('lock', SCHEMA)).toEqual({ verb: 'add', exact: true }) // schema alias
    expect(matchVerb('massage', SCHEMA)).toEqual({ verb: 'message', exact: false })
    expect(matchVerb('ping', SCHEMA)).toEqual({ verb: 'echo', exact: true })
    expect(matchVerb('kick', SCHEMA)).toEqual({ verb: 'start', exact: true })
    expect(matchVerb('stat', SCHEMA)).toEqual({ verb: 'start', exact: false })
    expect(matchVerb('banana', SCHEMA)).toBeNull()
  })
})

describe('schema note', () => {
  it('the seed parses cleanly and matches the defaults where it should', () => {
    const p = parseSchemaNote(seedSchemaNote())
    expect(p.found).toBe(true)
    expect(p.errors).toEqual([])
    expect(p.schema.fallback).toBe('al')
    expect(p.schema.verbs.add.targets.movies).toEqual({ file: 'scratch/lists/movie-list.md', dated: false, enrich: 'movie', aliases: ['movie', 'film', 'films'] })
    expect(p.schema.verbs.add.targets.groceries).toEqual({ file: 'scratch/lists/groceries.md', dated: false, aliases: ['grocery', 'shopping'] })
    expect(p.schema.verbs.add.targets.dream).toMatchObject({ file: 'scratch/lists/dream.md', dated: true })
    expect(p.schema.verbs.add.aliases).toContain('log')
    expect(p.schema.verbs.echo.aliases).toContain('ping')
  })
  it('missing fence → defaults + found:false; bad yaml → error', () => {
    expect(parseSchemaNote('# nothing here')).toMatchObject({ found: false, schema: DEFAULT_SCHEMA })
    const bad = parseSchemaNote('```yaml\nverbs: [\n```')
    expect(bad.found).toBe(true)
    expect(bad.errors[0]).toMatch(/^yaml/)
  })
  it('validates shapes and unknown verbs/enrichers without dropping the rest', () => {
    const p = parseSchemaNote('```yaml\nfallback: null\nverbs:\n  add:\n    targets:\n      films: { file: x.md, enrich: imdb }\n      books: 12\n      todo:\n  message:\n    contacts:\n      mum: mai\n  dance: {}\n```')
    expect(p.schema.fallback).toBeNull()
    expect(p.schema.verbs.add.targets.films).toEqual({ file: 'x.md', dated: false, aliases: [] })
    expect(p.schema.verbs.add.targets.books).toBeUndefined()
    expect(p.schema.verbs.add.targets.todo).toEqual({ file: 'scratch/lists/todo.md', dated: false, aliases: [] })
    expect(p.errors.join('\n')).toMatch(/enrich: unknown enricher "imdb"/)
    expect(p.errors.join('\n')).toMatch(/books: expected a path/)
    expect(p.errors.join('\n')).toMatch(/contacts.mum: expected a LIST/) // old nickname→user shape rejected, not inverted
    expect(p.errors.join('\n')).toMatch(/verbs.dance: unknown verb/)
  })
  it('flags a spoken form claimed by two targets or two contacts', () => {
    const p = parseSchemaNote('```yaml\nverbs:\n  add:\n    targets:\n      dream: { aliases: [log] }\n      diary: { aliases: [log] }\n  message:\n    contacts:\n      mai: [mum]\n      nica: [mum]\n```')
    expect(p.errors.join('\n')).toMatch(/"log" is claimed by both target dream and target diary/)
    expect(p.errors.join('\n')).toMatch(/"mum" is claimed by both contacts mai and nica/)
  })
})

describe('routeByRules (schema-driven tree)', () => {
  const r = (t: string) => routeByRules(t, SCHEMA, ENV)
  it('log <target> <text> is add with a dated target; STT punctuation + aliases + fuzzy tolerated', () => {
    expect(r('Log dream. I was escaping a prison made of cheese')).toMatchObject({ rule: 'add.log', command: { kind: 'list', target: 'dream', file: 'scratch/lists/dream.md', dated: true, item: 'I was escaping a prison made of cheese' } })
    expect(r('lock dreems it was dark')).toMatchObject({ command: { kind: 'list', target: 'dream', dated: true } })
    expect(r('log journal just finished sowing the seeds for this season')).toMatchObject({ command: { target: 'journal', dated: true, item: 'just finished sowing the seeds for this season' } })
    expect(r('log system feeling flat today')).toMatchObject({ command: { target: 'emotion', dated: true } })
    expect(r('add dream flying again')).toMatchObject({ command: { target: 'dream', dated: true } }) // verb doesn't matter, target does
    expect(r('log food two eggs')).toMatchObject({ rule: 'add.unknown-target', command: { kind: 'unknown-target', verb: 'add', target: 'food' } })
  })
  it('a FUZZY verb with an unknown target is not a command — falls through (the "look at…" misfire)', () => {
    expect(r('Look at the movie titles that Veronica sent me and open the URLs')).toBeNull() // look ≈ lock, target "at" unknown
    expect(r('massage therapy is on tuesday')).toBeNull() // massage ≈ message, "therapy" is nobody
    expect(r('lock food two eggs')).toMatchObject({ rule: 'add.unknown-target' }) // exact alias → real bad target
  })
  it('add <list> <item> and add <project> <text>', () => {
    expect(r('Add movies Spiderman')).toMatchObject({ rule: 'add.list', command: { kind: 'list', target: 'movies', item: 'Spiderman', dated: false, enrich: 'movie' } })
    expect(r('add film Dune')).toMatchObject({ command: { target: 'movies' } })
    expect(r('ad shopping eggs')).toMatchObject({ command: { kind: 'list', target: 'groceries', item: 'eggs', dated: false } })
    expect(r('add console the login button is misaligned')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'console', column: 'Backlog', text: 'the login button is misaligned' } })
    expect(r('add reflection tools export to csv')).toMatchObject({ command: { kind: 'card', project: 'reflection-tools', text: 'export to csv' } })
    expect(r('add nonsense thing')).toMatchObject({ command: { kind: 'unknown-target', verb: 'add', target: 'nonsense' } })
  })
  it('start <project> <text> goes straight to the dispatch column; lists are not startable', () => {
    expect(r('Start console fix the login button')).toMatchObject({ rule: 'start.card', command: { kind: 'card', project: 'console', column: 'In Progress', text: 'fix the login button' } })
    expect(r('kick astera chase the invoice')).toMatchObject({ command: { kind: 'card', project: 'astera', column: 'In Progress' } })
    expect(r('do reflection tools export to csv')).toMatchObject({ command: { project: 'reflection-tools', column: 'In Progress', text: 'export to csv' } })
    expect(r('start movies Dune')).toMatchObject({ rule: 'start.unknown-target', command: { kind: 'unknown-target', verb: 'start' } })
  })
  it('message <person> <text> via nickname or username', () => {
    expect(r("Message mum I'll be home in 30 mins")).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'yasmina-amar', spoken: 'mum', text: "I'll be home in 30 mins" } })
    expect(r('text nika running late')).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'nica' } })
    expect(r('message sam-miller hi')).toMatchObject({ rule: 'message', command: { contact: 'sam-miller' } })
    expect(r('message sam hi')).toMatchObject({ rule: 'message', command: { contact: 'sam-miller' } }) // first name, derived
    expect(r('message al are you there')).toMatchObject({ rule: 'message', command: { contact: 'al', text: 'are you there' } })
    expect(r('text owl ping')).toMatchObject({ rule: 'message', command: { contact: 'al' } })
    expect(r('message stranger hi')).toMatchObject({ command: { kind: 'unknown-target', verb: 'message' } })
  })
  it('there is no agent verb — "tell" is a message alias, bare names are unclaimed', () => {
    expect(r("tell mum I'm late")).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'yasmina-amar', text: "I'm late" } })
    expect(r('agent console fix the build')).toBeNull()
    expect(r('Console, restart the dev server')).toBeNull()
    expect(r('ask owl what time is it')).toBeNull()
  })
  it('echo <text> — no target, payload verbatim', () => {
    expect(r('Echo testing one two three')).toMatchObject({ rule: 'echo', command: { kind: 'echo', text: 'testing one two three' } })
    expect(r('ping, is this thing on')).toMatchObject({ command: { kind: 'echo', text: 'is this thing on' } })
    expect(r('echo')).toBeNull()
  })
  it('music transport is a word set — any order, one action — plus play <query>', () => {
    expect(r('pause the music')).toMatchObject({ rule: 'music.pause' })
    expect(r('Skip.')).toMatchObject({ command: { action: 'next' } })
    expect(r('play')).toMatchObject({ rule: 'music.play' })
    expect(r('Music plays.')).toMatchObject({ rule: 'music.play', command: { kind: 'music', action: 'play' } }) // the live miss
    expect(r('music on')).toMatchObject({ command: { action: 'play' } })
    expect(r('stop the music please')).toMatchObject({ command: { action: 'pause' } })
    expect(r('next song')).toMatchObject({ command: { action: 'next' } })
    expect(r('play some Radiohead')).toMatchObject({ rule: 'music.play-query', command: { query: 'Radiohead' } })
    // The live miss (^quick-deer): a punctuated address word before the verb.
    expect(r('Music, play "Fate of Ophelia".')).toMatchObject({ rule: 'music.play-query', command: { query: 'Fate of Ophelia' } })
    expect(r('Spotify: play Taylor Swift')).toMatchObject({ rule: 'music.play-query', command: { query: 'Taylor Swift' } })
    expect(r('music play Radiohead')).toMatchObject({ rule: 'music.play-query', command: { query: 'Radiohead' } }) // unpunctuated form still works
    expect(r('Music, pause.')).toMatchObject({ rule: 'music.pause' })
    expect(r('Spotify, next track')).toMatchObject({ command: { action: 'next' } })
    expect(r("play 'Fate of Ophelia'")).toMatchObject({ command: { query: 'Fate of Ophelia' } })
    expect(r("play Don't Stop Me Now")).toMatchObject({ command: { query: "Don't Stop Me Now" } }) // apostrophe is not a quote pair
    expect(matchMusicTransport('on')).toBeNull() // bare on/off/back mean nothing
    expect(matchMusicTransport('go back')).toBeNull() // no noun → not music
    expect(matchMusicTransport('play pause')).toBeNull() // two actions
    expect(matchMusicTransport('play the long game')).toBeNull() // unknown word
  })
  it('"al <text>" is the escape hatch — straight to AL, no tree, no classifier', () => {
    expect(r('Al, look at the movie titles Veronica sent me')).toMatchObject({ rule: 'al.direct', command: { kind: 'fallback', agentKey: 'al', text: 'look at the movie titles Veronica sent me' } })
    expect(r('owl what time is it')).toMatchObject({ rule: 'al.direct', command: { text: 'what time is it' } })
    expect(r('al')).toBeNull() // name alone is nothing
    expect(r('all good here')).toBeNull() // exact match only
  })
  it('unmatched → null (caller decides LLM / fallback)', () => {
    expect(r('remind me to water the plants')).toBeNull()
    expect(r('Al')).toBeNull()
    expect(r('')).toBeNull()
  })
  it('describeCommand covers every kind', () => {
    expect(describeCommand({ kind: 'card', project: 'console', column: 'Backlog', text: 'x' })).toBe('card → console (Backlog): x')
    expect(describeCommand({ kind: 'unknown-target', verb: 'log', target: 'food', text: 'x' })).toBe('log: no target called "food"')
    expect(describeCommand({ kind: 'fallback', agentKey: 'al', text: 'hi' })).toBe('→ @al (fallback): hi')
    expect(describeCommand({ kind: 'list', target: 'dream', file: 'f', item: 'x', dated: true })).toBe('log dream: x')
    expect(describeCommand({ kind: 'echo', text: 'x' })).toBe('echo: x')
  })
})

describe('llm fallback parsing', () => {
  it('accepts only on-schema replies with known targets', () => {
    expect(parseClassifyReply('{"kind":"agent","targetId":"s2","message":"buy milk"}', SCHEMA, ENV, 'x')).toBeNull() // no agent verb
    expect(parseClassifyReply('{"kind":"list","target":"dream","item":"flying"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'list', file: 'scratch/lists/dream.md', dated: true })
    expect(parseClassifyReply('{"kind":"list","target":"food","item":"eggs"}', SCHEMA, ENV, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"list","target":"movies","item":"Dune"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'list', enrich: 'movie', dated: false })
    expect(parseClassifyReply('{"kind":"echo","text":"hi"}', SCHEMA, ENV, 'x')).toEqual({ kind: 'echo', text: 'hi' })
    expect(parseClassifyReply('{"kind":"card","project":"console","text":"fix"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'card', column: 'Backlog' })
    expect(parseClassifyReply('{"kind":"card","project":"console","text":"fix","start":true}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'card', column: 'In Progress' })
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
    expect(p).toContain('yasmina-amar←mum/sister/yasmina')
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
    const d = await describeSchema({ schema: SCHEMA, errors: [], stale: false, path: 'p.md' }, { ...ENV, agents: AGENTS, echoConfigured: false }, async (p) => p.endsWith('movie-list.md'))
    expect(d.fallback).toEqual({ agentKey: 'al', live: true })
    const add = d.verbs.find((v) => v.verb === 'add')!
    expect(add.targets.find((t) => t.name === 'movies')!.note).toBeUndefined()
    expect(add.targets.find((t) => t.name === 'groceries')!.note).toMatch(/created on first use/)
    expect(add.targets.find((t) => t.name === 'console')!.resolves).toBe('board card → Backlog')
    expect(add.targets.find((t) => t.name === 'dream')!.resolves).toMatch(/^log scratch\/lists\/dream.md/)
    const msg = d.verbs.find((v) => v.verb === 'message')!
    expect(msg.targets.find((t) => t.name === 'yasmina-amar')).toMatchObject({ ok: true, aliases: ['mum', 'sister', 'yasmina'] }) // 'yasmina' listed explicitly here, so not doubled
    expect(msg.targets.find((t) => t.name === 'al')).toMatchObject({ ok: true, resolves: "AL's own WhatsApp DM" })
    expect(d.verbs.find((v) => v.verb === 'echo')!.note).toMatch(/NOTIFY_JID unset/)
    expect(d.verbs.map((v) => v.verb)).toEqual(['add', 'start', 'message', 'echo', 'music'])
  })
})

describe('RingStore + pipeline', () => {
  let dir: string
  let store: RingStore
  let toAl: string[]
  let toAgent: Array<{ key: string; content: string }>
  let echoed: string[]
  let sentAsYousef: Array<{ contact: string; text: string }>
  let notified: Array<{ title: string; body: string }>
  let music: string[]
  let notes: Map<string, string>
  let cards: string[]
  let schema: RingSchema
  let ctx: RingCtx

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ring-'))
    store = new RingStore(dir)
    toAl = []; toAgent = []; echoed = []; sentAsYousef = []; notified = []; music = []; cards = []
    notes = new Map()
    schema = structuredClone(SCHEMA)
    ctx = {
      store,
      schema: async () => ({ schema, errors: [] }),
      describeSchema: async () => { throw new Error('unused') },
      env: async () => ENV,
      deliverToAl: (envelope) => { toAl.push(envelope); return true },
      deliverToAgent: (key, content) => { if (key === 'dead') return false; toAgent.push({ key, content }); return true },
      whatsappToYousef: async (text) => { echoed.push(text); return '447000@s.whatsapp.net' },
      chatSendAsYousef: async (contact, text) => { if (contact === 'nobody') throw new Error('no WhatsApp DM room found for nobody'); sentAsYousef.push({ contact, text }); return `${contact} (dm)` },
      notes: { read: async (p) => notes.get(p) ?? null, write: async (p, c) => { notes.set(p, c) } },
      addCard: async (project, text, column) => { cards.push(`${project}/${column}: ${text}`); return `"${text}" → ${column}` },
      music: {
        play: async (q) => { music.push(`play:${q ?? ''}`); return 'ok' },
        pause: async () => { music.push('pause'); return 'ok' },
        next: async () => { music.push('next'); return 'ok' },
        previous: async () => { music.push('prev'); return 'ok' },
      },
      transcribe: async () => 'weather from stt',
      classify: async (text) => text.includes('skippity') ? { kind: 'music', action: 'next' } : null,
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
    expect(rec.route).toMatchObject({ via: 'default', ok: true, command: { kind: 'fallback', agentKey: 'al' } })
    expect(toAl[0]).toBe(buildFallbackEnvelope('What is the weather like', rec.id))
    expect(toAl[0]).toMatch(/^\[RING — unclaimed voice command/)
    expect(notified[0]).toMatchObject({ title: 'Ring → AL', body: 'What is the weather like' })
    expect(JSON.parse(readFileSync(join(dir, 'ring', 'recordings', `${rec.id}.json`), 'utf8')).route.ok).toBe(true)
    expect(store.count()).toBe(1)
  })

  it('log appends a dated bullet to the target note', async () => {
    const rec = await deliver('log dream I was escaping a prison made of cheese')
    expect(rec.route).toMatchObject({ rule: 'add.log', ok: true })
    expect(notes.get('scratch/lists/dream.md')).toBe('## 2026-09-02\n- 23:07 I was escaping a prison made of cheese\n')
    expect(notified[0]).toMatchObject({ title: 'Ring · log dream', body: 'I was escaping a prison made of cheese' })
    await deliver('add journal sowed the seeds')
    expect(notes.get('scratch/lists/journal.md')).toBe('## 2026-09-02\n- 23:07 sowed the seeds\n')
  })

  it('echo goes straight to WhatsApp, no LLM', async () => {
    const rec = await deliver('echo testing one two')
    expect(rec.route).toMatchObject({ rule: 'echo', ok: true, detail: 'sent to 447000@s.whatsapp.net' })
    expect(echoed).toEqual(['testing one two'])
    expect(notified[0]).toMatchObject({ title: 'Ring · echo → WhatsApp', body: 'testing one two' })
    ctx.whatsappToYousef = async () => { throw new Error('WhatsApp not connected') }
    expect((await deliver('echo again')).route).toMatchObject({ ok: false, detail: 'WhatsApp not connected' })
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

  it('message sends AS YOUSEF through his own chat, never via AL', async () => {
    const rec = await deliver("message mum I'll be home in 30 mins")
    expect(rec.route).toMatchObject({ rule: 'message', ok: true, detail: 'yasmina-amar (dm)' })
    expect(sentAsYousef).toEqual([{ contact: 'yasmina-amar', text: "I'll be home in 30 mins" }])
    expect(toAl).toHaveLength(0)
    expect(notified[0]).toMatchObject({ title: 'Ring → mum (yasmina-amar (dm))', body: "I'll be home in 30 mins" })
    ENV.contacts.push('nobody')
    expect((await deliver('message nobody hi')).route).toMatchObject({ ok: false, detail: 'no WhatsApp DM room found for nobody' })
    ENV.contacts.pop()
  })

  it('a verb with an unknown target is actionable feedback, not a fallback', async () => {
    const rec = await deliver('log food two eggs')
    expect(rec.route).toMatchObject({ rule: 'add.unknown-target', ok: false })
    expect(toAl).toHaveLength(0)
    expect(notified[0]!.body).toMatch(/no add target called "food"/)
  })

  it('falls back to hub STT when the ring sent no transcript', async () => {
    const rec = await processDelivery(ctx, { transcription: null, audio: { data: Buffer.from('x'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    expect(rec.transcriptionSource).toBe('hub-stt')
    expect(rec.route?.command).toMatchObject({ kind: 'fallback', agentKey: 'al', text: 'weather from stt' })
  })

  it('al.direct goes to AL without consulting the classifier', async () => {
    let classified = 0
    ctx.classify = async () => { classified++; return null }
    const rec = await deliver('Al, look at the movie titles')
    expect(rec.route).toMatchObject({ via: 'rule', rule: 'al.direct', ok: true })
    expect(toAl[0]).toBe(buildFallbackEnvelope('look at the movie titles', rec.id))
    expect(classified).toBe(0)
  })

  it('store.failures() lists undelivered recordings for the Home alerts log', async () => {
    await deliver('echo fine')
    await deliver('log food two eggs')
    ctx.transcribe = async () => null
    await processDelivery(ctx, { transcription: null, audio: { data: Buffer.from('x'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    const f = store.failures(Date.now() - 60_000)
    expect(f.map((x) => x.message)).toEqual(['recording could not be transcribed', '"log food two eggs" — no add target called "food" — add it to the ring schema note'])
    expect(store.failures(Date.now() + 1)).toEqual([])
  })

  it('LLM only when rules miss, then the fallback agent, then unknown', async () => {
    expect((await deliver('uh skippity doo')).route).toMatchObject({ via: 'llm', command: { kind: 'music', action: 'next' } })
    expect(music).toEqual(['next'])
    expect((await deliver('remind me to water the plants')).route).toMatchObject({ via: 'default', ok: true, command: { kind: 'fallback', agentKey: 'al' } })
    schema.fallback = 'console-general'
    expect((await deliver('remind me to water the plants')).route).toMatchObject({ via: 'default', ok: true })
    expect(toAgent.at(-1)!.key).toBe('console-general')
    schema.fallback = 'dead'
    expect((await deliver('remind me to water the plants')).route).toMatchObject({ via: 'default', ok: false, detail: '@dead is not live' })
    schema.fallback = null; schema.llmFallback = false
    const none = await deliver('remind me to water the plants')
    expect(none.route).toMatchObject({ via: 'none', ok: false, command: { kind: 'unknown' } })
    expect(notified.at(-1)!.title).toBe('Ring: not delivered')
  })

  it('reports a dead AL instead of pretending', async () => {
    ctx.deliverToAl = () => false
    expect((await deliver('what is the weather like')).route).toMatchObject({ via: 'default', ok: false, detail: 'AL is not live' })
  })

  it('the ring fork seed carries the tree and the schema-gap instruction', () => {
    const seed = buildRingForkSeed(SCHEMA)
    expect(seed).toMatch(/^\[RING FORK\]/)
    expect(seed).toContain('projects/console/ring-schema.md')
    expect(seed).toContain('start <project> <text>   → board card in In Progress')
    expect(seed).toContain('logs, dated: dream, journal, emotion')
    expect(seed).toContain('echo <text>')
    expect(seed).toContain('sent AS YOUSEF from his own chat account')
    expect(seed).not.toContain('RELAY')
    expect(seed).toContain('con spaces board console add "Ring schema gap:')
    expect(seed).toContain('Do not edit the schema note yourself')
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

describe('ContactRoomResolver', () => {
  it('ghost id forms + parsing', () => {
    expect(ghostUserIds('+44 7599 712846')).toEqual(['@whatsapp_447599712846:beeper.local', '@whatsapp_lid-447599712846:beeper.local'])
    expect(identifierFromGhost('@whatsapp_lid-153635979829408:beeper.local')).toBe('153635979829408')
    expect(identifierFromGhost('@whatsapp_447599712846:beeper.local')).toBe('447599712846')
    expect(identifierFromGhost('@whatsappbot:beeper.local')).toBeNull()
    expect(identifierFromGhost('@drmr:beeper.com')).toBeNull()
  })
  it('matches a contact to the direct WhatsApp room whose ghost carries one of their ids; caches; skips non-DMs', async () => {
    const rooms = [
      { id: '!group', name: 'Family', isDirect: false, networkIcon: 'whatsapp' },
      { id: '!signal', name: 'Nica', isDirect: true, networkIcon: 'signal' },
      { id: '!nica', name: 'Nica🐈‍⬛', isDirect: true, networkIcon: 'whatsapp' },
      { id: '!lucas', name: 'Lucas', isDirect: true, networkIcon: 'whatsapp' },
    ]
    const fetched: string[] = []
    const members: Record<string, string[]> = {
      '!group': ['@whatsapp_1:beeper.local', '@whatsapp_2:beeper.local'],
      '!signal': ['@signal_1:beeper.local'],
      '!nica': ['@whatsappbot:beeper.local', '@drmr:beeper.com', '@whatsapp_lid-999:beeper.local'],
      '!lucas': ['@whatsappbot:beeper.local', '@drmr:beeper.com', '@whatsapp_447:beeper.local'],
    }
    const r = new ContactRoomResolver(() => rooms, async (id) => { fetched.push(id); return members[id] ?? [] })
    expect((await r.resolve('nica', ['4479', '999']))?.id).toBe('!nica') // lid form
    expect((await r.resolve('lucas', ['447']))?.id).toBe('!lucas')
    expect(fetched).not.toContain('!group')
    expect(fetched).not.toContain('!signal')
    const before = fetched.length
    expect((await r.resolve('nica', ['999']))?.id).toBe('!nica')
    expect(fetched.length).toBe(before) // cached
    expect(await r.resolve('stranger', ['123'])).toBeNull()
    expect(await r.resolve('noids', [])).toBeNull()
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
