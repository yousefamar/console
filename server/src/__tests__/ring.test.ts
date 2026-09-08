import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMultipart, buildMultipart, multipartBoundary } from '../ring/multipart.js'
import { normalise, routeByRules, describeCommand, editDistance, fuzzyEqual, pickFuzzy, resolveSpoken, matchVerb, matchMusicTransport, headWords, type RouteEnv } from '../ring/router.js'
import { parseClassifyReply, buildClassifyPrompt } from '../ring/llm-fallback.js'
import { parseSchemaNote, seedSchemaNote, DEFAULT_SCHEMA, describeSchema, spokenForms, contactForms, type RingSchema } from '../ring/schema.js'
import { RingSchemaLoader } from '../ring/schema-loader.js'
import { appendLogEntry } from '../ring/append.js'
import { parseTable, ensureColumns, appendRow, setCells, removeRow, rowRecord, stamp } from '../lists/table.js'
import { ENRICHERS, columnsFor, rawRow, GROCERIES_ORDERED_LOG, type EnricherDeps } from '../lists/enrichers.js'
import { ListWatcher } from '../lists/watcher.js'
import { RingStore } from '../ring/store.js'
import { processDelivery, buildFallbackEnvelope, buildRingForkSeed, buildMissCard, type RingCtx } from '../ring/pipeline.js'
import { ContactRoomResolver, ghostUserIds, identifierFromGhost, expandIdentifiers } from '../ring/chat-room.js'
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
    expect(p.schema.verbs.add.targets.groceries).toEqual({ file: 'scratch/lists/groceries.md', dated: false, enrich: 'grocery-order', aliases: ['grocery', 'shopping'] })
    expect(p.schema.verbs.add.targets.dream).toMatchObject({ file: 'scratch/lists/dream.md', dated: true })
    expect(p.schema.verbs.add.aliases).toContain('log')
    expect(p.schema.verbs.echo.aliases).toContain('ping')
    expect(p.schema.onFailure).toEqual({ column: 'In Progress' })
  })
  it('on_failure: column, string shorthand, null = off', () => {
    expect(parseSchemaNote('```yaml\non_failure: { column: Backlog }\n```').schema.onFailure).toEqual({ column: 'Backlog' })
    expect(parseSchemaNote('```yaml\non_failure: Backlog\n```').schema.onFailure).toEqual({ column: 'Backlog' })
    expect(parseSchemaNote('```yaml\non_failure: null\n```').schema.onFailure).toEqual({ column: null })
    expect(parseSchemaNote('```yaml\non_failure: { column: null }\n```').schema.onFailure).toEqual({ column: null })
    const bad = parseSchemaNote('```yaml\non_failure: [x]\n```')
    expect(bad.schema.onFailure).toEqual({ column: 'In Progress' })
    expect(bad.errors.join()).toMatch(/on_failure/)
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
  it('trailing target: "<item> to [the|my] <target> [list]" — natural speech puts the target last', () => {
    expect(r('Add Count of Monte Cristo to movie list')).toMatchObject({ rule: 'add.list', command: { kind: 'list', target: 'movies', item: 'Count of Monte Cristo', dated: false, enrich: 'movie' } })
    expect(r('add eggs to the shopping list')).toMatchObject({ command: { kind: 'list', target: 'groceries', item: 'eggs' } })
    expect(r('log I was flying to dreams')).toMatchObject({ rule: 'add.log', command: { kind: 'list', target: 'dream', item: 'I was flying', dated: true } })
    expect(r('add note to self to movie list')).toMatchObject({ command: { target: 'movies', item: 'note to self' } }) // several "to"s — the resolving split wins
    expect(r('add the login button is misaligned to console')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'console', text: 'the login button is misaligned' } })
    expect(r('add export to csv to reflection tools')).toMatchObject({ command: { kind: 'card', project: 'reflection-tools', text: 'export to csv' } })
    // Fallback only: a first-word target keeps the whole payload as the item.
    expect(r('add movies Journey to the Center of the Earth')).toMatchObject({ rule: 'add.list', command: { target: 'movies', item: 'Journey to the Center of the Earth' } })
    expect(r('add nonsense to whatever')).toMatchObject({ command: { kind: 'unknown-target', verb: 'add' } })
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
    expect(r('message stranger hi')).toMatchObject({ command: { kind: 'unknown-target', verb: 'message' } })
  })
  it('message/text/tell AL is a WhatsApp send FROM YOUSEF to AL\'s DM — he wants AL to reply on WhatsApp (never rerouted to al.direct)', () => {
    expect(r('message al are you there')).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'al', text: 'are you there' } })
    expect(r('Message Al Hi')).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'al', text: 'Hi' } })
    expect(r('text owl ping')).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'al', text: 'ping' } })
    expect(r('tell AL to check the calendar')).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'al', text: 'check the calendar' } })
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
  it('timer <duration> → the glasses countdown; cancel words clear it; a non-duration falls through (^wavy-crow)', () => {
    expect(r('Timer 10 minutes.')).toMatchObject({ rule: 'timer.start', command: { kind: 'timer', seconds: 600 } })
    expect(r('set a timer for ten minutes')).toMatchObject({ rule: 'timer.start', command: { kind: 'timer', seconds: 600 } })
    expect(r('countdown 1:30')).toMatchObject({ rule: 'timer.start', command: { kind: 'timer', seconds: 90 } })
    expect(r('timer an hour and a half')).toMatchObject({ command: { kind: 'timer', seconds: 5400 } })
    expect(r('timer cancel')).toMatchObject({ rule: 'timer.cancel', command: { kind: 'timer', seconds: null } })
    expect(r('Set the timer off.')).toMatchObject({ rule: 'timer.cancel' })
    expect(r('stop the timer')).toBeNull()               // verb-first only: "stop" is not a timer alias
    expect(r('set the mood')).toBeNull()                  // exact verb, remainder is not a duration → LLM/fallback, never an error
    expect(r('time to leave for the station')).toBeNull() // time ≈ timer fuzzily; not a duration
    expect(r('timer')).toBeNull()
  })
  it('head punctuation is dropped for EVERY rule, payloads keep theirs (^quick-deer review)', () => {
    // headWords: the one tokeniser every rule reads through.
    expect(headWords('Log dream. I was late, then early.', 2)).toEqual({ words: ['log', 'dream'], rest: 'I was late, then early.' })
    expect(headWords('Message Nica — I\'m late', 2)).toEqual({ words: ['message', 'nica'], rest: "I'm late" })
    expect(headWords('Music… pause', 1)).toEqual({ words: ['music'], rest: 'pause' })
    expect(headWords('Al?', 1)).toEqual({ words: ['al'], rest: '' })
    expect(headWords('play', 2)).toBeNull()
    // Verb tree: ";" "!" "?" and dash separators, not just the old ",.:" set.
    expect(r('Log; dream! I was flying')).toMatchObject({ rule: 'add.log', command: { item: 'I was flying' } })
    expect(r('Message Nica — running late, sorry.')).toMatchObject({ rule: 'message', command: { contact: 'nica', text: 'running late, sorry' } })
    expect(r('Add movies? The Godfather')).toMatchObject({ rule: 'add.list', command: { item: 'The Godfather' } })
    // Two-word project slug with a comma after its second word.
    expect(r('Add reflection tools, fix the login')).toMatchObject({ rule: 'add.card', command: { project: 'reflection-tools', text: 'fix the login' } })
    // AL address and echo with odd punctuation.
    expect(r('Al… what time is it')).toMatchObject({ rule: 'al.direct', command: { text: 'what time is it' } })
    expect(r('Echo! testing')).toMatchObject({ rule: 'echo', command: { text: 'testing' } })
    // Music through the same tokeniser — no music-specific vocative regex.
    expect(r('Music; play Radiohead')).toMatchObject({ rule: 'music.play-query', command: { query: 'Radiohead' } })
    expect(r('Spotify — pause!')).toMatchObject({ rule: 'music.pause' })
    expect(matchMusicTransport('music, next.')).toBe('next')
    // Payload punctuation survives: the dream keeps its full stop and comma.
    expect(r('Log dream. I was late, then early.')).toMatchObject({ command: { item: 'I was late, then early' } }) // only the utterance-final "." goes (normalise)
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
    // ^ripe-orca: the same mis-hearings with a query attached, and a noun after the verb.
    expect(r('Music, plays Taylor Swift.')).toMatchObject({ rule: 'music.play-query', command: { query: 'Taylor Swift' } })
    expect(r('Music, playing Taylor Swift.')).toMatchObject({ rule: 'music.play-query', command: { query: 'Taylor Swift' } })
    expect(r('Play music Fate of Ophelia')).toMatchObject({ command: { query: 'Fate of Ophelia' } }) // noun after the verb is address, not search
    expect(r('Play some music, Radiohead.')).toMatchObject({ command: { query: 'Radiohead' } })
    expect(r('Music, play Taylor Swift please.')).toMatchObject({ command: { query: 'Taylor Swift' } })
    expect(r('Music - play')).toMatchObject({ rule: 'music.play' }) // dash / ellipsis vocatives
    expect(r('Music… play Radiohead')).toMatchObject({ command: { query: 'Radiohead' } })
    expect(r('Playing tennis with Sam later')).toBeNull() // unaddressed "playing" is a note, not a search
    expect(r('Log journal went to see a play')).toMatchObject({ rule: 'add.log' }) // trailing "play" inside a real command is untouched
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
    expect(parseClassifyReply('{"kind":"message","contact":"al","text":"hi"}', SCHEMA, ENV, 'x')).toMatchObject({ kind: 'message', contact: 'al' }) // a real send to AL's DM, not rerouted
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
  it('log: the day heading is the LOCAL date, so a post-midnight BST entry is not filed a day early', () => {
    // 2026-09-06T23:16Z = 00:16 on the 7th in BST — the bullet says 00:16, so
    // the heading must say the 7th (it used to be the UTC 6th).
    const pastMidnightBst = new Date('2026-09-06T23:16:24.423Z')
    expect(appendLogEntry(null, 'late thought', pastMidnightBst)).toBe('## 2026-09-07\n- 00:16 late thought\n')
  })
})

describe('table helpers', () => {
  const at = new Date(2026, 8, 6, 10, 47)
  it('appendRow creates the table on first use, after any existing content', () => {
    const out = appendRow('- old bullet\n', columnsFor(undefined), rawRow(undefined, 'penne au chocolat', stamp(at)))
    expect(out).toBe('- old bullet\n\n| Item | Added |\n| ---- | ----- |\n| penne au chocolat | 2026-09-06 10:47 |\n')
    const again = appendRow(out, columnsFor(undefined), rawRow(undefined, 'eggs', stamp(at)))
    expect(again.trimEnd().split('\n').at(-1)).toBe('| eggs              | 2026-09-06 10:47 |')
  })
  it('appendRow migrates an existing table that lacks columns (movie list gains Added)', () => {
    const table = '| Title      | Year | Series | Watched |\n| ---------- | ---- | ------ | ------- |\n| Vivarium   | 2019 | No     | Yes     |\n|            |      |        |         |\n'
    const out = appendRow(table, columnsFor('movie'), rawRow('movie', 'Dune | Part Two', stamp(at)))
    const lines = out.trimEnd().split('\n')
    expect(lines[0]).toBe('| Title | Year | Series | Watched | Added |')
    expect(lines[2]).toMatch(/^\| Vivarium\s+\| 2019 \| No\s+\| Yes\s+\|\s+\|$/) // padded with an empty Added
    expect(lines.at(-1)).toMatch(/^\| Dune \/ Part Two \|\s+\| \s*\| No\s+\| 2026-09-06 10:47 \|$/) // raw row: Year/Series blank, Watched default
    const t = parseTable(lines)!
    expect(t.rows).toHaveLength(2) // the blank editor row is ignored
    expect(rowRecord(t, t.rows[1]!)).toMatchObject({ title: 'Dune / Part Two', year: '', watched: 'No' })
  })
  it('setCells rewrites only the named columns of one row', () => {
    const md = appendRow(null, columnsFor('movie'), rawRow('movie', 'spiderman', stamp(at)))
    const t = parseTable(md.split('\n'))!
    const out = setCells(md, t.rows[0]!.line, { Title: 'Spider-Man', Year: '2002', Series: 'No' })
    const t2 = parseTable(out.split('\n'))!
    expect(rowRecord(t2, t2.rows[0]!)).toMatchObject({ title: 'Spider-Man', year: '2002', series: 'No', watched: 'No', added: '2026-09-06 10:47' })
  })
  it('ensureColumns is idempotent and case-insensitive', () => {
    const md = '| item | added |\n| --- | --- |\n| x | y |'
    const { lines } = ensureColumns(md.split('\n'), ['Item', 'Added'])
    expect(lines.join('\n')).toBe(md)
  })
  it('columnsFor / rawRow per enricher', () => {
    expect(columnsFor(undefined)).toEqual(['Item', 'Added'])
    expect(columnsFor('movie')).toEqual(['Title', 'Year', 'Series', 'Watched', 'Added'])
    expect(rawRow('movie', 'Dune', 'now')).toEqual({ Title: 'Dune', Watched: 'No', Added: 'now' })
  })
})

describe('movie enricher', () => {
  const movie = ENRICHERS.movie!
  const deps = (llm: (p: string) => Promise<string | null>): EnricherDeps => ({ llm, exec: async () => ({ code: 1, stdout: '', stderr: 'unused' }), log: () => {} })
  it('pending = has a title, no year', () => {
    expect(movie.pending({ title: 'Dune', year: '' })).toBe(true)
    expect(movie.pending({ title: 'Dune', year: '2021' })).toBe(false)
    expect(movie.pending({ title: '', year: '' })).toBe(false)
  })
  it('run fills from the LLM reply; an unidentifiable/invalid reply leaves the row pending with retry', async () => {
    expect(await movie.run([{ title: 'spiderman' }], deps(async () => 'Sure: {"title":"Spider-Man","year":2002,"series":"No"}'))).toEqual([{ kind: 'fill', cells: { Title: 'Spider-Man', Year: '2002', Series: 'No' } }])
    expect(await movie.run([{ title: 'thing' }], deps(async () => '{"title":"","year":"","series":""}'))).toMatchObject([{ kind: 'skip', retry: true }])
    expect(await movie.run([{ title: 'thing' }], deps(async () => null))).toMatchObject([{ kind: 'skip', retry: true }])
  })
})

describe('grocery-order enricher (queue drain)', () => {
  const g = ENRICHERS['grocery-order']!
  type Call = { cmd: string; args: string[] }
  function fakeSainsburys(status: object | null, opts: { searchHits?: Record<string, Array<{ product_uid: string; name: string }>>; checkoutCode?: number; addCode?: number } = {}) {
    const calls: Call[] = []
    const exec: EnricherDeps['exec'] = async (cmd, args) => {
      calls.push({ cmd, args })
      const sub = args.slice(0, 2).join(' ')
      if (sub === 'order status') return status ? { code: 0, stdout: JSON.stringify(status), stderr: '' } : { code: 1, stdout: '', stderr: '401' }
      if (sub === 'auth login') return { code: 0, stdout: 'ok', stderr: '' }
      if (sub === 'order amend') return { code: 0, stdout: '', stderr: '' }
      if (sub === 'product search') return { code: 0, stdout: JSON.stringify({ products: opts.searchHits?.[args[2]!] ?? [] }), stderr: '' }
      if (sub === 'basket add') return { code: opts.addCode ?? 0, stdout: '', stderr: '' }
      if (args[0] === 'checkout') return { code: opts.checkoutCode ?? 0, stdout: '', stderr: opts.checkoutCode ? 'boom' : '' }
      return { code: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` }
    }
    return { calls, exec }
  }
  const llmPick = async (p: string) => (p.includes('none fits') ? (p.includes('Crunchy Nut') ? '{"index": 1}' : '{"index": 0}') : null)
  const OPEN = { active: true, order_uid: '1342297016', is_in_amend_mode: false, is_cutoff: false }

  it('pending = any item present', () => {
    expect(g.pending({ item: 'eggs' })).toBe(true)
    expect(g.pending({ item: '' })).toBe(false)
  })
  it('no open order → rows stay, no retry backoff, nothing added', async () => {
    const f = fakeSainsburys({ active: false })
    expect(await g.run([{ item: 'eggs' }], { llm: llmPick, exec: f.exec, log: () => {} })).toEqual([{ kind: 'skip', retry: false, reason: 'no open order' }])
    expect(f.calls.map((c) => c.args[0])).toEqual(['order'])
  })
  it('open order past cutoff → stay', async () => {
    const f = fakeSainsburys({ ...OPEN, is_cutoff: true })
    expect(await g.run([{ item: 'eggs' }], { llm: llmPick, exec: f.exec, log: () => {} })).toMatchObject([{ kind: 'skip', retry: false }])
  })
  it('open order → amend, search + pick, add each, ONE checkout, rows drained with a log note', async () => {
    const f = fakeSainsburys(OPEN, { searchHits: { eggs: [{ product_uid: '111', name: 'Free Range Eggs x6' }], cereal: [{ product_uid: '221', name: 'Corn Flakes' }, { product_uid: '222', name: 'Crunchy Nut' }] } })
    const out = await g.run([{ item: 'eggs' }, { item: 'cereal' }, { item: 'unobtainium' }], { llm: llmPick, exec: f.exec, log: () => {} })
    expect(out).toEqual([
      { kind: 'remove', note: 'eggs → Free Range Eggs x6 (order 1342297016)', logTo: GROCERIES_ORDERED_LOG },
      { kind: 'remove', note: 'cereal → Crunchy Nut (order 1342297016)', logTo: GROCERIES_ORDERED_LOG },
      { kind: 'skip', retry: true, reason: 'no product matched "unobtainium"' },
    ])
    const seq = f.calls.map((c) => c.args.slice(0, 2).join(' '))
    expect(seq).toEqual(['order status', 'order amend', 'product search', 'basket add', 'product search', 'basket add', 'product search', 'checkout --yes'])
    expect(f.calls.find((c) => c.args[0] === 'basket')!.args).toEqual(['basket', 'add', '111', '-q', '1', '--slot-booked'])
    expect(f.calls.filter((c) => c.args[0] === 'checkout')).toHaveLength(1)
  })
  it('already in amend mode → no second amend; checkout failure → nothing leaves the list', async () => {
    const f = fakeSainsburys({ ...OPEN, is_in_amend_mode: true }, { searchHits: { eggs: [{ product_uid: '111', name: 'Eggs' }] }, checkoutCode: 1 })
    const out = await g.run([{ item: 'eggs' }], { llm: llmPick, exec: f.exec, log: () => {} })
    expect(out).toMatchObject([{ kind: 'skip', retry: true, reason: expect.stringMatching(/checkout failed/) }])
    expect(f.calls.some((c) => c.args[1] === 'amend')).toBe(false)
  })
  it('expired session → login once, then proceed', async () => {
    let first = true
    const f = fakeSainsburys(OPEN, { searchHits: { eggs: [{ product_uid: '111', name: 'Eggs' }] } })
    const exec: EnricherDeps['exec'] = async (cmd, args) => {
      if (args.slice(0, 2).join(' ') === 'order status' && first) { first = false; return { code: 1, stdout: '', stderr: '401' } }
      return f.exec(cmd, args)
    }
    const out = await g.run([{ item: 'eggs' }], { llm: llmPick, exec, log: () => {} })
    expect(out).toMatchObject([{ kind: 'remove' }])
    expect(f.calls.some((c) => c.args[0] === 'auth')).toBe(true)
  })
  it('never books a slot or places a fresh order', async () => {
    const f = fakeSainsburys(OPEN, { searchHits: { eggs: [{ product_uid: '111', name: 'Eggs' }] } })
    await g.run([{ item: 'eggs' }], { llm: llmPick, exec: f.exec, log: () => {} })
    expect(f.calls.some((c) => c.args[0] === 'slot')).toBe(false)
    expect(f.calls.filter((c) => c.args[0] === 'checkout').every((c) => c.args.includes('--slot-booked'))).toBe(true)
  })
})

describe('table removeRow', () => {
  it('drops exactly the row, keeps header and neighbours', () => {
    const md = appendRow(appendRow(null, ['Item', 'Added'], { Item: 'a', Added: 't' }), ['Item', 'Added'], { Item: 'b', Added: 't' })
    const t = parseTable(md.split('\n'))!
    const out = removeRow(md, t.rows[0]!.line)
    const t2 = parseTable(out.split('\n'))!
    expect(t2.rows.map((r) => rowRecord(t2, r).item)).toEqual(['b'])
    expect(removeRow(md, 999)).toBe(md)
  })
})

describe('ListWatcher', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ring-lists-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const targets = async () => ({ movies: { file: 'lists/movies.md', dated: false, enrich: 'movie' }, groceries: { file: 'lists/groceries.md', dated: false, enrich: 'grocery-order' } })
  const noExec: EnricherDeps['exec'] = async () => ({ code: 1, stdout: '', stderr: 'unused' })

  it('fills pending rows (ring-written or hand-typed), leaves finished rows alone, backs off failures', async () => {
    const store = new NoteStore(dir, join(dir, 'tomb.json'))
    mkdirSync(join(dir, 'lists'), { recursive: true })
    const at = new Date(2026, 8, 6, 10, 47)
    let md = appendRow(null, columnsFor('movie'), rawRow('movie', 'spiderman', stamp(at)))
    md = appendRow(md, columnsFor('movie'), rawRow('movie', 'obscure thing', stamp(at)))
    md = setCells(md, 2, {}) // no-op, keeps shape
    // A hand-typed row: no Added, no Watched — still just a title without a year.
    md = md.trimEnd() + '\n| Vivarium | | | | |\n'
    writeFileSync(join(dir, 'lists', 'movies.md'), md)
    const calls: string[] = []
    const llm = async (prompt: string) => {
      const spoken = /Spoken: "([^"]+)"/.exec(prompt)?.[1] ?? ''
      calls.push(spoken)
      if (spoken === 'spiderman') return '{"title":"Spider-Man","year":"2002","series":"No"}'
      if (spoken === 'Vivarium') return '{"title":"Vivarium","year":"2019","series":"No"}'
      return '{"title":"","year":"","series":""}'
    }
    let clock = Date.now()
    const w = new ListWatcher(store, { targets, deps: { llm, exec: noExec }, log: () => {}, now: () => clock, quietMs: 0, retryMs: 10 * 60_000 })
    expect(await w.runNow()).toBe(2)
    const t = parseTable(readFileSync(join(dir, 'lists', 'movies.md'), 'utf8').split('\n'))!
    expect(t.rows.map((r) => rowRecord(t, r))).toMatchObject([
      { title: 'Spider-Man', year: '2002', series: 'No', watched: 'No' },
      { title: 'obscure thing', year: '' },
      { title: 'Vivarium', year: '2019' },
    ])
    expect(calls.sort()).toEqual(['Vivarium', 'obscure thing', 'spiderman'])
    // Second pass: the failure is in backoff (poll path), nothing is re-asked.
    // (Fake clock jumps well past the real file mtime so later polls see no change,
    // however slowly the runner got here.)
    calls.length = 0
    clock = Date.now() + 60_000
    await w.poll()
    expect(calls).toEqual([])
    clock += 61_000
    await w.poll() // still inside the backoff window, file unchanged → nothing
    expect(calls).toEqual([])
    expect(await w.runNow()).toBe(0) // force asks again; still unidentifiable
    expect(calls).toEqual(['obscure thing'])
  })

  it('poll reacts to a changed list note; a file touched within quietMs waits', async () => {
    const store = new NoteStore(dir, join(dir, 'tomb.json'))
    mkdirSync(join(dir, 'lists'), { recursive: true })
    let clock = Date.now()
    const calls: string[] = []
    const w = new ListWatcher(store, { targets, deps: { llm: async (p) => { calls.push(p); return '{"title":"Dune","year":"2021","series":"No"}' }, exec: noExec }, log: () => {}, now: () => clock, quietMs: 5_000 })
    await w.start()
    expect(calls).toEqual([])
    writeFileSync(join(dir, 'lists', 'movies.md'), appendRow(null, columnsFor('movie'), rawRow('movie', 'dune', '2026-09-06 10:47')))
    // Anchor the fake clock to the REAL write time — the quiet window is
    // measured against the file's actual mtime.
    clock = Date.now() + 1_000
    await w.poll() // too fresh → deferred
    expect(calls).toEqual([])
    clock += 10_000
    await w.poll()
    expect(calls).toHaveLength(1)
    expect(readFileSync(join(dir, 'lists', 'movies.md'), 'utf8')).toMatch(/\| Dune\s+\| 2021 \| No\s+\| No\s+\| 2026-09-06 10:47 \|/)
    w.stop()
  })

  it('queue drain: removed rows leave the table and land in the dated ordered-log; skipped rows stay', async () => {
    const store = new NoteStore(dir, join(dir, 'tomb.json'))
    mkdirSync(join(dir, 'lists'), { recursive: true })
    let md = appendRow(null, columnsFor('grocery-order'), rawRow('grocery-order', 'eggs', '2026-09-06 10:47'))
    md = appendRow(md, columnsFor('grocery-order'), rawRow('grocery-order', 'unobtainium', '2026-09-06 10:48'))
    writeFileSync(join(dir, 'lists', 'groceries.md'), md)
    const exec: EnricherDeps['exec'] = async (_cmd, args) => {
      const sub = args.slice(0, 2).join(' ')
      if (sub === 'order status') return { code: 0, stdout: JSON.stringify({ active: true, order_uid: '42', is_in_amend_mode: true, is_cutoff: false }), stderr: '' }
      if (sub === 'product search') return { code: 0, stdout: JSON.stringify({ products: args[2] === 'eggs' ? [{ product_uid: '1', name: 'Eggs x6' }] : [] }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const w = new ListWatcher(store, { targets, deps: { llm: async () => '{"index": 0}', exec }, log: () => {}, now: () => new Date(2026, 8, 6, 11, 0).getTime(), quietMs: 0 })
    expect(await w.runNow()).toBe(1)
    const t = parseTable(readFileSync(join(dir, 'lists', 'groceries.md'), 'utf8').split('\n'))!
    expect(t.rows.map((r) => rowRecord(t, r).item)).toEqual(['unobtainium'])
    expect(readFileSync(join(dir, GROCERIES_ORDERED_LOG), 'utf8')).toBe('## 2026-09-06\n- 11:00 eggs → Eggs x6 (order 42)\n')
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
    expect(msg.targets.find((t) => t.name === 'al')).toMatchObject({ ok: true, resolves: "AL's own WhatsApp DM (as Yousef)" })
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
  let missCards: Array<{ text: string; column: string }>
  let notified: Array<{ title: string; body: string }>
  let music: string[]
  let timers: Array<number | null>
  let notes: Map<string, string>
  let cards: string[]
  let schema: RingSchema
  let ctx: RingCtx

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ring-'))
    store = new RingStore(dir)
    toAl = []; toAgent = []; echoed = []; sentAsYousef = []; missCards = []; notified = []; music = []; cards = []; timers = []
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
      fileMissCard: async (miss, column) => { missCards.push({ text: buildMissCard(miss).text, column }); return 'filed' },
      music: {
        play: async (q) => { music.push(`play:${q ?? ''}`); return 'ok' },
        pause: async () => { music.push('pause'); return 'ok' },
        next: async () => { music.push('next'); return 'ok' },
        previous: async () => { music.push('prev'); return 'ok' },
      },
      glassesTimer: async (seconds) => { timers.push(seconds); return seconds === null ? 'timer cancelled' : `timer running` },
      transcribe: async () => 'weather from stt',
      classify: async (text) => text.includes('skippity') ? { kind: 'music', action: 'next' } : null,
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

  it('timer runs the glasses countdown through ctx.glassesTimer; a refused frame is a failed delivery', async () => {
    const rec = await deliver('timer 10 minutes')
    expect(rec.route).toMatchObject({ rule: 'timer.start', ok: true, detail: 'timer running' })
    expect(timers).toEqual([600])
    expect(notified[0]).toMatchObject({ title: 'Ring · timer', body: 'timer running' })
    await deliver('timer cancel')
    expect(timers).toEqual([600, null])
    ctx.glassesTimer = async () => { throw new Error('glasses APK not connected') }
    expect((await deliver('timer 5 minutes')).route).toMatchObject({ ok: false, detail: 'glasses APK not connected' })
  })

  it('echo goes straight to WhatsApp, no LLM', async () => {
    const rec = await deliver('echo testing one two')
    expect(rec.route).toMatchObject({ rule: 'echo', ok: true, detail: 'sent to 447000@s.whatsapp.net' })
    expect(echoed).toEqual(['testing one two'])
    expect(notified[0]).toMatchObject({ title: 'Ring · echo → WhatsApp', body: 'testing one two' })
    ctx.whatsappToYousef = async () => { throw new Error('WhatsApp not connected') }
    expect((await deliver('echo again')).route).toMatchObject({ ok: false, detail: 'WhatsApp not connected' })
  })

  it('add <list> writes the RAW table row with an Added stamp — enrichment is the watcher\'s job', async () => {
    notes.set('scratch/lists/movie-list.md', '| Title | Year | Series | Watched |\n| --- | --- | --- | --- |\n')
    await deliver('add movies spiderman')
    const movies = notes.get('scratch/lists/movie-list.md')!
    expect(movies.split('\n')[0]).toBe('| Title | Year | Series | Watched | Added |') // migrated header
    expect(movies.trimEnd().split('\n').at(-1)).toMatch(/^\| spiderman \|\s+\|\s+\| No\s+\| 2026-09-02 23:07 \|$/)
    expect(notified.at(-1)).toMatchObject({ title: 'Ring · add movies', body: 'spiderman' })
    await deliver('add groceries eggs')
    expect(notes.get('scratch/lists/groceries.md')).toBe('| Item | Added |\n| ---- | ----- |\n| eggs | 2026-09-02 23:07 |\n')
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

  it('a verb with an unknown target is actionable feedback, not a fallback — and files a Ring miss card', async () => {
    const rec = await deliver('log food two eggs')
    expect(rec.route).toMatchObject({ rule: 'add.unknown-target', ok: false, card: 'filed' })
    expect(toAl).toHaveLength(0)
    expect(notified[0]!.body).toMatch(/no add target called "food"/)
    expect(missCards).toEqual([{ text: 'Ring miss: "log food two eggs" → no add target called "food" — add it to the ring schema note', column: 'In Progress' }])
    // A successful delivery files nothing; with on_failure off, neither does a failure.
    await deliver('echo fine')
    expect(missCards).toHaveLength(1)
    schema.onFailure = { column: null }
    const again = await deliver('log food two eggs')
    expect(again.route?.card).toBeUndefined()
    expect(missCards).toHaveLength(1)
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
    // Same-millisecond recordings order by their random id suffix — compare as a set.
    expect(f.map((x) => x.message).sort()).toEqual(['"log food two eggs" — no add target called "food" — add it to the ring schema note', 'recording could not be transcribed'])
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
    expect(none.route?.card).toBeUndefined() // no fallback configured is a choice, not a miss
    expect(notified.at(-1)!.title).toBe('Ring: not delivered')
  })

  it('reports a dead AL instead of pretending', async () => {
    ctx.deliverToAl = () => false
    expect((await deliver('what is the weather like')).route).toMatchObject({ via: 'default', ok: false, detail: 'AL is not live' })
  })

  it('the miss card handles-first, fixes-second, and points at the recording', () => {
    const c = buildMissCard({ recordingId: 'r1', transcription: 'Message Al High', via: 'rule', rule: 'message', detail: 'no WhatsApp DM room found for al' })
    expect(c.text).toBe('Ring miss: "Message Al High" → no WhatsApp DM room found for al')
    expect(c.detail[0]).toContain('con ring show r1')
    expect(c.detail[1]).toMatch(/^1\. FIRST, interpret the transcript and DO what Yousef asked/)
    expect(c.detail[2]).toMatch(/^2\. THEN fix the cause/)
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
  it('expandIdentifiers adds the lid each phone maps to, so a lid-keyed room resolves from a phone-only contact (^glad-ibis)', async () => {
    const lidFor = async (d: string) => d === '447' ? '34154016194786' : d === '999' ? null : Promise.reject(new Error('offline'))
    expect(await expandIdentifiers(['447'], lidFor)).toEqual(['447', '34154016194786'])
    expect(await expandIdentifiers(['+44 7', '447', '999', ''], lidFor)).toEqual(['447', '999', '34154016194786']) // digits-only, dedup, null skipped
    expect(await expandIdentifiers(['555'], lidFor)).toEqual(['555']) // lookup failure is not fatal
    const rooms = [{ id: '!al', name: 'Al', isDirect: true, networkIcon: 'whatsapp' }]
    const r = new ContactRoomResolver(() => rooms, async () => ['@whatsappbot:beeper.local', '@drmr:beeper.com', '@whatsapp_lid-34154016194786:beeper.local'])
    expect(await r.resolve('al', ['447'])).toBeNull() // phone alone never matched — the live failure
    expect((await r.resolve('al', await expandIdentifiers(['447'], lidFor)))?.id).toBe('!al')
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
