import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMultipart, buildMultipart, multipartBoundary } from '../ring/multipart.js'
import { normalise, normaliseKeepCase, routeByRules, describeCommand, editDistance, fuzzyEqual, pickFuzzy, resolveSpoken, matchVerb, matchMusicTransport, headWords, stripLeadIn, isVerbatim, findWordRun, wordKeys, scanFirstSentence, type RouteEnv } from '../ring/router.js'
import { parseClassifyReply, buildClassifyPrompt, payloadFor } from '../ring/llm-fallback.js'
import { parseSchemaNote, seedSchemaNote, DEFAULT_SCHEMA, describeSchema, spokenForms, contactForms, type RingSchema } from '../ring/schema.js'
import { RingSchemaLoader } from '../ring/schema-loader.js'
import { appendLogEntry } from '../ring/append.js'
import { parseTable, ensureColumns, appendRow, setCells, removeRow, rowRecord, stamp } from '../lists/table.js'
import { ENRICHERS, columnsFor, rawRow, GROCERIES_ORDERED_LOG, type EnricherDeps } from '../lists/enrichers.js'
import { ListWatcher } from '../lists/watcher.js'
import { RingStore } from '../ring/store.js'
import { processDelivery, buildFallbackEnvelope, buildRingForkSeed, buildMissCard, spliceHeadPayload, sttVocabulary, type RingCtx } from '../ring/pipeline.js'
import { ContactRoomResolver, ghostUserIds, identifierFromGhost, expandIdentifiers } from '../ring/chat-room.js'
import { payloadStart, snapToGap, parseEnvelope, patchOpusVendor, oggCrc, pcmWaveform, type TimedWord, type Frame, type VoiceClip } from '../ring/voice.js'
import { deliveryFromRequest } from '../routes/ring.js'
import { parseReminder, parseClockTime, dueAt, formatDue, formatReminder, describeWhen, RingReminders } from '../ring/remind.js'
import { NoteStore } from '../notes.js'

const AGENTS = [{ agentKey: 'console-general' }, { agentKey: 'al' }]
const ENV: RouteEnv = { projects: ['console', 'astera', 'reflection-tools', 'al'], contacts: ['al', 'nica', 'sam-miller', 'yasmina-amar'], rooms: ['control room', 'al', 'family'] }
const SCHEMA: RingSchema = parseSchemaNote(seedSchemaNote()).schema
SCHEMA.verbs.message.contacts = { al: ['owl', 'hal'], 'yasmina-amar': ['mum', 'sister', 'yasmina'], nica: ['nika', 'veronica'] }
SCHEMA.verbs.message.rooms = { 'control room': ['control'], 'yes theory london fam': ['yes theory'] }

// Recording 2026-09-16T05-21-31.691Z-1238: Yousef said "Log dream. These are
// three dreams. I had a dream…" (~200 words); the ring wrote "Look, these are
// three dreams." and the LLM fallback logged a 40-word SUMMARY (^green-carp).
const DREAM = JSON.parse(readFileSync(new URL('./fixtures/ring-2026-09-16T05-21-31.691Z-1238.json', import.meta.url), 'utf8')) as { transcription: string; route: { command: { item: string } } }
const DREAM_LEAD_IN = 'Look, these are three dreams.'
/** What must be logged: every word after the lead-in, as spoken (bullets are one line, so paragraph breaks collapse). */
const DREAM_BODY = DREAM.transcription.slice(DREAM_LEAD_IN.length).replace(/\s+/g, ' ').trim()
/** What hub STT hears in the first 10 s, primed with the tree's vocabulary. */
const DREAM_HEAD = 'Log dream. These are three dreams. I had a dream that first I ordered some nice food to the house but I'

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
    expect(p.schema.projects).toEqual({ al: ['l', 'el', 'owl', 'hal'] })
  })
  it('projects: slug → spoken forms; a string value is rejected like a contact', () => {
    const p = parseSchemaNote('```yaml\nprojects:\n  Console: [consul, council]\n  astera: al\n```')
    expect(p.schema.projects).toEqual({ console: ['consul', 'council'] })
    expect(p.errors.join('\n')).toMatch(/projects.astera: expected a LIST/)
    expect(parseSchemaNote('```yaml\nfallback: al\n```').schema.projects).toEqual(DEFAULT_SCHEMA.projects)
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
  it('flags a spoken form claimed by two targets, two contacts, or a contact and a room', () => {
    const p = parseSchemaNote('```yaml\nverbs:\n  add:\n    targets:\n      dream: { aliases: [log] }\n      diary: { aliases: [log] }\n  message:\n    contacts:\n      mai: [mum]\n      nica: [mum, fam]\n    rooms:\n      family: [fam]\n```')
    expect(p.errors.join('\n')).toMatch(/"log" is claimed by both target dream and target diary/)
    expect(p.errors.join('\n')).toMatch(/"mum" is claimed by both contact mai and contact nica/)
    expect(p.errors.join('\n')).toMatch(/"fam" is claimed by both contact nica and room family/)
    expect(p.schema.verbs.message.rooms).toEqual({ family: ['fam'] })
    // Projects share the add namespace with list targets: `add <word> …` must resolve one way.
    const q = parseSchemaNote('```yaml\nprojects:\n  al: [l, films]\n  console: [l]\n```')
    expect(q.errors.join('\n')).toMatch(/"films" is claimed by both target movies and project al/)
    expect(q.errors.join('\n')).toMatch(/"l" is claimed by both project al and project console/)
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
  it('project spoken forms from the note: "al" is too short to fuzzy-match, the STT hears "L"', () => {
    expect(r('Add L test card.')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'al', column: 'Backlog', text: 'test card' } })
    expect(r('add el test card')).toMatchObject({ command: { kind: 'card', project: 'al' } })
    expect(r('add al test card')).toMatchObject({ command: { kind: 'card', project: 'al' } })
    expect(r('start owl fix the draft')).toMatchObject({ rule: 'start.card', command: { kind: 'card', project: 'al', column: 'In Progress', text: 'fix the draft' } })
    expect(r('add fix the draft to hal')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'al', text: 'fix the draft' } })
    // A form for a slug the hub has no board for never resolves — unknown-target, not a card into the void.
    expect(routeByRules('add l test card', { ...SCHEMA, projects: { ghost: ['l'] } }, ENV)).toMatchObject({ command: { kind: 'unknown-target', verb: 'add', target: 'l' } })
    expect(routeByRules('add l test card', SCHEMA, { ...ENV, projects: ['console'] })).toMatchObject({ command: { kind: 'unknown-target' } })
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
  it('voice <person> <speech> — the recording as a voice note; the person may sit behind "note"/"message"/"to"', () => {
    expect(r("Voice mum, I'll be home in 30 mins")).toMatchObject({ rule: 'voice', command: { kind: 'voice', contact: 'yasmina-amar', spoken: 'mum', text: "I'll be home in 30 mins" } })
    expect(r('voice note nika running late')).toMatchObject({ rule: 'voice', command: { kind: 'voice', contact: 'nica', spoken: 'nika', text: 'running late' } })
    expect(r('Voice message to Sam. Hi Sam, calling about Tuesday.')).toMatchObject({ rule: 'voice', command: { contact: 'sam-miller', spoken: 'sam', text: 'Hi Sam, calling about Tuesday' } })
    expect(r('voicenote al are you there')).toMatchObject({ rule: 'voice', command: { kind: 'voice', contact: 'al', text: 'are you there' } })
    expect(r('audio owl ping')).toMatchObject({ rule: 'voice', command: { contact: 'al' } })
    expect(r('voice stranger hi')).toMatchObject({ rule: 'voice.unknown-target', command: { kind: 'unknown-target', verb: 'voice', target: 'stranger' } })
    expect(r('voice note stranger hi')).toMatchObject({ rule: 'voice.unknown-target', command: { kind: 'unknown-target', verb: 'voice', target: 'stranger' } })
    expect(r('voice note to for the record hi')).toMatchObject({ command: { kind: 'unknown-target', verb: 'voice', target: 'for' } }) // two phrase words max
    expect(r('voyce stranger hi')).toBeNull() // fuzzy verb + unknown person is not a command
    expect(r('voice mum')).toBeNull() // nothing to send
    expect(describeCommand(r("voice mum I'm late")!.command)).toBe("voice note → mum (yasmina-amar): I'm late")
  })
  it('message|voice <room> — a group chat from the note\'s rooms:, by its (multi-word) name or a spoken form (^fond-bass)', () => {
    // Recording 2026-09-19T09-56-52.948Z-e313: "Voice control room. This is a test." died as `no voice target called "control"`.
    expect(r('Voice control room. This is a test.')).toMatchObject({ rule: 'voice', command: { kind: 'voice', contact: 'control room', spoken: 'control room', text: 'This is a test' } })
    expect(r('voice control this is a test')).toMatchObject({ rule: 'voice', command: { kind: 'voice', contact: 'control room', spoken: 'control', text: 'this is a test' } })
    expect(r('voice note to control room testing')).toMatchObject({ rule: 'voice', command: { contact: 'control room', text: 'testing' } })
    expect(r('message control room hello all')).toMatchObject({ rule: 'message', command: { kind: 'message', contact: 'control room', spoken: 'control room', text: 'hello all' } })
    expect(r('message yes theory london fam anyone around?')).toMatchObject({ rule: 'message', command: { contact: 'yes theory london fam', text: 'anyone around' } })
    expect(r('message yes theory anyone around?')).toMatchObject({ rule: 'message', command: { contact: 'yes theory london fam', spoken: 'yes theory' } })
    expect(r('message control roon hello')).toMatchObject({ rule: 'message', command: { contact: 'control room', text: 'hello' } }) // one edit, multi-word
    expect(r('message control room')).toBeNull() // a recipient with nothing after it is no command — never "room" as the payload
    expect(r('message mum control the room')).toMatchObject({ command: { contact: 'yasmina-amar', text: 'control the room' } }) // a person first still wins
    expect(describeCommand(r('voice control room testing')!.command)).toBe('voice note → control room (control room): testing')
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
  it('remind [me] <text> — the words verbatim, default delay; a time phrase leads or trails (^prim-fawn)', () => {
    const THE_RING = 'to not leave the ring in the bathroom or it will be sold on the black market'
    expect(r(`Remind me ${THE_RING}.`)).toMatchObject({ rule: 'remind.default', command: { kind: 'remind', text: THE_RING, when: { kind: 'in', seconds: 7200 }, spoken: null } })
    expect(r('Reminder: buy milk')).toMatchObject({ rule: 'remind.default', command: { kind: 'remind', text: 'buy milk' } })
    expect(r('remember the parcel')).toMatchObject({ command: { kind: 'remind', text: 'the parcel' } })
    // Leading time phrase — the longest run that parses ("an hour and a half", not "an hour").
    expect(r('remind me in 20 minutes to check the oven')).toMatchObject({ rule: 'remind.at', command: { kind: 'remind', text: 'to check the oven', when: { kind: 'in', seconds: 1200 }, spoken: 'in 20 minutes' } })
    expect(r('remind me in an hour and a half to call mum')).toMatchObject({ command: { text: 'to call mum', when: { kind: 'in', seconds: 5400 } } })
    expect(r('remind me at 5pm to leave')).toMatchObject({ command: { text: 'to leave', when: { kind: 'at', hour: 17, minute: 0, explicit: true, dayOffset: 0 }, spoken: 'at 5pm' } })
    expect(r('remind me tomorrow morning to water the plants')).toMatchObject({ command: { text: 'to water the plants', when: { kind: 'at', hour: 9, minute: 0, dayOffset: 1 } } })
    expect(r('remind me tomorrow at 9 to water the plants')).toMatchObject({ command: { text: 'to water the plants', when: { kind: 'at', hour: 9, dayOffset: 1 } } })
    // Trailing — the rightmost marker whose tail parses wholly wins.
    expect(r('remind me to check the oven in 20 minutes')).toMatchObject({ command: { text: 'to check the oven', when: { kind: 'in', seconds: 1200 }, spoken: 'in 20 minutes' } })
    expect(r('remind me to check the oven in 20')).toMatchObject({ command: { text: 'to check the oven', when: { kind: 'in', seconds: 1200 } } })
    expect(r('remind me to be at the station at 6')).toMatchObject({ command: { text: 'to be at the station', when: { kind: 'at', hour: 6, explicit: false } } })
    expect(r('remind me to call Max, at half past five')).toMatchObject({ command: { text: 'to call Max', when: { kind: 'at', hour: 5, minute: 30 } } })
    expect(r('remind me to call mum tomorrow')).toMatchObject({ command: { text: 'to call mum', when: { kind: 'at', hour: 9, dayOffset: 1 } } })
    expect(r('remind me to call mum tomorrow at 5')).toMatchObject({ command: { text: 'to call mum', when: { kind: 'at', hour: 17, dayOffset: 1 } } })
    // Words that only LOOK like time markers stay in the text.
    expect(r('remind me to put the ring in the bathroom')).toMatchObject({ command: { text: 'to put the ring in the bathroom', spoken: null } })
    expect(r('remind me to look at the report')).toMatchObject({ command: { text: 'to look at the report', spoken: null } })
    expect(r('remind me to pay the bill at the end of the month')).toMatchObject({ command: { text: 'to pay the bill at the end of the month', spoken: null } })
    // A fuzzy verb needs "me" or a time phrase; "remind" alone or a time with nothing to remember is no command.
    expect(r('rewind to 2 minutes')).toBeNull()
    expect(r('remind')).toBeNull()
    expect(r('remind me tomorrow')).toBeNull()
    expect(r('remind me at 5')).toBeNull()
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
  it('a glued "@" is the spoken verb "at"/"add" — "@Estera, …" is add astera (recording 2026-09-15T22-08-57.774Z, ^tidy-toad)', () => {
    expect(headWords('@Estera, this is a test ticket', 1)).toEqual({ words: ['at'], rest: 'Estera, this is a test ticket' })
    expect(headWords('@Estera, this is a test ticket', 2)).toEqual({ words: ['at', 'estera'], rest: 'this is a test ticket' })
    expect(headWords('@ Estera this is a test ticket', 2)).toEqual({ words: ['at', 'estera'], rest: 'this is a test ticket' }) // bare "@" token
    expect(r('@Estera, this is a test ticket.')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'astera', column: 'Backlog', text: 'this is a test ticket' } })
    expect(r('@console the login button is misaligned')).toMatchObject({ rule: 'add.card', command: { kind: 'card', project: 'console', text: 'the login button is misaligned' } })
    expect(r('@movies Dune')).toMatchObject({ rule: 'add.list', command: { kind: 'list', target: 'movies', item: 'Dune' } })
    // Only head words are split — an "@" inside the payload is left as spoken.
    expect(r('add console mention @yousef in the release note')).toMatchObject({ command: { kind: 'card', project: 'console', text: 'mention @yousef in the release note' } })
    expect(r("message mum meet you @ the station")).toMatchObject({ command: { kind: 'message', text: 'meet you @ the station' } })
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
    expect(r('book me a table for two')).toBeNull()
    expect(r('Al')).toBeNull()
    expect(r('')).toBeNull()
  })
  it('describeCommand covers every kind', () => {
    expect(describeCommand({ kind: 'card', project: 'console', column: 'Backlog', text: 'x' })).toBe('card → console (Backlog): x')
    expect(describeCommand({ kind: 'unknown-target', verb: 'log', target: 'food', text: 'x' })).toBe('log: no target called "food"')
    expect(describeCommand({ kind: 'fallback', agentKey: 'al', text: 'hi' })).toBe('→ @al (fallback): hi')
    expect(describeCommand({ kind: 'list', target: 'dream', file: 'f', item: 'x', dated: true })).toBe('log dream: x')
    expect(describeCommand({ kind: 'echo', text: 'x' })).toBe('echo: x')
    expect(describeCommand({ kind: 'remind', text: 'to leave', when: { kind: 'in', seconds: 7200 }, spoken: null })).toBe('remind in 2h: to leave')
    expect(describeCommand({ kind: 'remind', text: 'to leave', when: { kind: 'at', hour: 5, minute: 0, explicit: false, dayOffset: 0 }, spoken: 'at 5' })).toBe('remind at 05:00 or 17:00 ("at 5"): to leave')
  })
})

describe('reminder time parsing', () => {
  const NOW = new Date(2026, 8, 19, 10, 0)   // Sat 19 Sep, 10:00 local

  it('parseClockTime: numbers, words, am/pm, 24 h, half/quarter past, named times, trailing tomorrow', () => {
    expect(parseClockTime('5')).toMatchObject({ hour: 5, minute: 0, explicit: false })
    expect(parseClockTime('5pm')).toMatchObject({ hour: 17, explicit: true })
    expect(parseClockTime('5 p.m.')).toMatchObject({ hour: 17, explicit: true })
    expect(parseClockTime('12 am')).toMatchObject({ hour: 0, explicit: true })
    expect(parseClockTime('5:30')).toMatchObject({ hour: 5, minute: 30, explicit: false })
    expect(parseClockTime('17.30')).toMatchObject({ hour: 17, minute: 30, explicit: true })
    expect(parseClockTime('05:00')).toMatchObject({ hour: 5, explicit: true })
    expect(parseClockTime("five o'clock")).toMatchObject({ hour: 5, explicit: false })
    expect(parseClockTime('half past five')).toMatchObject({ hour: 5, minute: 30 })
    expect(parseClockTime('quarter to six')).toMatchObject({ hour: 5, minute: 45 })
    expect(parseClockTime('6 in the evening')).toMatchObject({ hour: 18, explicit: true })
    expect(parseClockTime('noon')).toMatchObject({ hour: 12, explicit: true })
    expect(parseClockTime('midnight')).toMatchObject({ hour: 0, explicit: true })
    expect(parseClockTime('9 tomorrow')).toMatchObject({ hour: 9, dayOffset: 1 })
    for (const bad of ['the report', 'it', 'the end of the month', '25', '5:75', 'one thing', '17pm']) expect(parseClockTime(bad)).toBeNull()
  })

  it('dueAt: a bare hour is the next one ahead (05 or 17), explicit hours roll to tomorrow once passed', () => {
    const at = (h: number, explicit: boolean, dayOffset = 0) => dueAt({ kind: 'at', hour: h, minute: 0, explicit, dayOffset }, NOW)
    expect(at(5, false)).toEqual(new Date(2026, 8, 19, 17, 0))     // 05:00 gone → 17:00
    expect(at(11, false)).toEqual(new Date(2026, 8, 19, 11, 0))    // ahead today
    expect(at(12, false)).toEqual(new Date(2026, 8, 19, 12, 0))
    expect(at(9, true)).toEqual(new Date(2026, 8, 20, 9, 0))       // 09:00 explicit, gone → tomorrow
    expect(at(17, true)).toEqual(new Date(2026, 8, 19, 17, 0))
    expect(at(9, true, 1)).toEqual(new Date(2026, 8, 20, 9, 0))
    expect(dueAt({ kind: 'at', hour: 5, minute: 0, explicit: false, dayOffset: 0 }, new Date(2026, 8, 19, 20, 0))).toEqual(new Date(2026, 8, 20, 5, 0))  // both gone → 05:00 tomorrow
    expect(dueAt({ kind: 'in', seconds: 7200 }, NOW)).toEqual(new Date(2026, 8, 19, 12, 0))
  })

  it('parseReminder default delay comes from the schema; formatDue / describeWhen / formatReminder', () => {
    expect(parseReminder('me to leave', 900)).toMatchObject({ when: { kind: 'in', seconds: 900 }, spoken: null })
    expect(formatDue(new Date(2026, 8, 19, 12, 0), NOW)).toBe('12:00')
    expect(formatDue(new Date(2026, 8, 20, 9, 0), NOW)).toBe('tomorrow 09:00')
    expect(formatDue(new Date(2026, 8, 22, 9, 0), NOW)).toBe('Tue 22 Sept 09:00')
    expect(describeWhen({ kind: 'in', seconds: 5400 })).toBe('in 1h30m')
    expect(describeWhen({ kind: 'in', seconds: 45 })).toBe('in 45s')
    expect(describeWhen({ kind: 'at', hour: 9, minute: 0, explicit: true, dayOffset: 1 })).toBe('tomorrow at 09:00')
    expect(formatReminder('to not leave the ring in the bathroom')).toBe('Reminder to not leave the ring in the bathroom')
    expect(formatReminder('that the parcel arrives at 5')).toBe('Reminder: the parcel arrives at 5')
    expect(formatReminder('buy milk')).toBe('Reminder: buy milk')
    expect(formatReminder('buy milk', { due: new Date(2026, 8, 19, 9, 0), now: NOW })).toBe('Reminder: buy milk (was due 09:00)')
    expect(formatReminder('buy milk', { due: new Date(2026, 8, 19, 9, 58), now: NOW })).toBe('Reminder: buy milk')
  })
})

describe('RingReminders (hub-scheduled one-shots)', () => {
  let dir: string
  let sent: string[]
  let notified: Array<{ title: string; body: string }>
  let clock: Date
  let failSend: string | null
  const deps = () => ({
    deliver: async (m: string) => { if (failSend) throw new Error(failSend); sent.push(m) },
    notify: (m: { title: string; body: string }) => notified.push({ title: m.title, body: m.body }),
    log: () => {},
    now: () => clock,
  })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ring-rem-')); sent = []; notified = []; failSend = null; clock = new Date(2026, 8, 19, 10, 0) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists, lists pending soonest-first, cancels, and fires with the formatted line + a push', async () => {
    const rem = new RingReminders(dir, deps())
    const late = rem.add('to leave', clock.getTime() + 3_600_000, 'rec-1')
    const soon = rem.add('that the parcel arrives', clock.getTime() + 60_000)
    expect(rem.pending().map((r) => r.id)).toEqual([soon.id, late.id])
    expect(JSON.parse(readFileSync(join(dir, 'ring', 'reminders.json'), 'utf8')).reminders).toHaveLength(2)
    expect(rem.cancel(late.id)).toBe(true)
    expect(rem.cancel(late.id)).toBe(false)
    expect(rem.pending().map((r) => r.id)).toEqual([soon.id])
    await rem.fire(soon.id)
    expect(sent).toEqual(['Reminder: the parcel arrives'])
    expect(notified).toEqual([{ title: 'Reminder', body: 'that the parcel arrives' }])
    expect(rem.pending()).toEqual([])
    expect(rem.list()[0]).toMatchObject({ id: late.id, cancelledAt: clock.getTime() })
    await rem.fire(soon.id)   // idempotent — a fired reminder never sends twice
    expect(sent).toHaveLength(1)
    rem.stop()
  })

  it('a reminder that came due while the hub was down fires at start, marked late; a fresh instance re-arms the rest', async () => {
    const a = new RingReminders(dir, deps())
    a.add('to take the ring off', clock.getTime() + 60_000)
    a.add('to call mum', clock.getTime() + 86_400_000)
    a.stop()
    clock = new Date(clock.getTime() + 30 * 60_000)   // hub down for 30 min
    const b = new RingReminders(dir, deps())
    b.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toEqual(['Reminder to take the ring off (was due 10:01)'])
    expect(b.pending().map((r) => r.text)).toEqual(['to call mum'])
    b.stop()
  })

  it('a failed send keeps the reminder pending for a retry; the push still went out once', async () => {
    const rem = new RingReminders(dir, deps())
    const r = rem.add('buy milk', clock.getTime() + 60_000)
    failSend = 'WhatsApp not connected'
    await rem.fire(r.id)
    expect(sent).toEqual([])
    expect(notified).toEqual([{ title: 'Reminder', body: 'buy milk' }])
    expect(rem.pending()[0]).toMatchObject({ id: r.id, attempts: 1, error: 'WhatsApp not connected' })
    failSend = null
    await rem.fire(r.id)   // the retry (here driven by hand)
    expect(sent).toEqual(['Reminder: buy milk'])
    expect(notified).toHaveLength(1)
    expect(rem.pending()).toEqual([])
    rem.stop()
  })
})

describe('add: target inside the first sentence', () => {
  const r = (t: string) => routeByRules(t, SCHEMA, ENV)
  it('"Look, these are three dreams. I had…" — look ≈ lock reaches add, the target is in the sentence, the payload follows it', () => {
    const m = r(DREAM.transcription)!
    expect(m).toMatchObject({ rule: 'add.log-sentence', weak: true, command: { kind: 'list', target: 'dream', dated: true } })
    expect((m.command as { item: string }).item).toBe(DREAM_BODY)
    expect(r('Log my dreams. Last night I was flying.')).toMatchObject({ rule: 'add.log-sentence', command: { target: 'dream', item: 'Last night I was flying' } })
    expect(r('Add to the movie list! Dune')).toMatchObject({ rule: 'add.list-sentence', command: { target: 'movies', item: 'Dune' } })
  })
  it('a head-slot target still wins outright, and is never weak', () => {
    expect(r('Log dream. These are three dreams. I had a dream.')).toMatchObject({ rule: 'add.log', command: { item: 'These are three dreams. I had a dream' } })
    expect(r('Log dream. These are three dreams. I had a dream.')!.weak).toBeUndefined()
  })
  it('no sentence boundary within ten words, or nothing after it → unknown-target as before (never a guess ten words in)', () => {
    expect(r('Look at the movie titles that Veronica sent me and open the URLs')).toBeNull() // fuzzy verb, no sentence → still not a command
    expect(r('Log my dreams I was flying over London and the river')).toMatchObject({ rule: 'add.unknown-target' })
    expect(r('Log these are three dreams.')).toMatchObject({ rule: 'add.unknown-target' })
    expect(scanFirstSentence('one two three four five six seven eight nine ten dreams. payload', spokenForms(SCHEMA.verbs.add.targets))).toBeNull()
    expect(scanFirstSentence('these are dreems. payload', spokenForms(SCHEMA.verbs.add.targets))).toBeNull() // exact forms only
  })
})

describe('voice note cut point', () => {
  // whisper-1 word timestamps over the head of recording 2026-09-17T14-23-31.175Z-eacb
  // ("Start console. I want to be able to speak a voice note…"), verified live.
  const W: TimedWord[] = [
    { word: 'Start', start: 0, end: 0.84 }, { word: 'console', start: 0.84, end: 1.58 }, { word: 'I', start: 1.94, end: 2.44 },
    { word: 'want', start: 2.44, end: 2.68 }, { word: 'a', start: 2.68, end: 3.08 }, { word: 'way', start: 3.08, end: 3.12 }, { word: 'to', start: 3.12, end: 3.64 },
  ]
  const T = 'Start console. I want to be able to speak a voice note directly into my ring.'
  const GAP = { lo: 1.58, hi: 1.94 }
  it('anchors the payload\'s opening words and cuts just ahead of the first one', () => {
    expect(payloadStart(W, T, 'I want to be able to speak a voice note directly into my ring')).toEqual({ t: 1.79, ...GAP }) // 1.94 − 0.15
  })
  it('tolerates a mis-heard payload word (3-word anchor fails, 2-word succeeds; both fail → head word count)', () => {
    expect(payloadStart(W, T, 'I want two be able')).toEqual({ t: 1.79, ...GAP })
    expect(payloadStart(W, 'Start console. Eye wants too be able', 'Eye wants too be able')).toEqual({ t: 1.79, ...GAP }) // nothing anchors → as many words as the head has (2)
    expect(payloadStart(W, 'Start console. Yes', 'Yes')).toEqual({ t: 1.79, ...GAP }) // one-word payload, unheard → head count
  })
  it('never cuts inside a word: a tight gap splits it, an overlap cuts at the onset', () => {
    const tight: TimedWord[] = [{ word: 'voice', start: 0, end: 0.5 }, { word: 'mum', start: 0.5, end: 0.9 }, { word: 'hi', start: 1.0, end: 1.3 }]
    expect(payloadStart(tight, 'voice mum hi', 'hi')).toEqual({ t: 0.95, lo: 0.9, hi: 1 })
    const overlap: TimedWord[] = [{ word: 'voice', start: 0, end: 0.5 }, { word: 'mum', start: 0.5, end: 1.1 }, { word: 'hi', start: 1.0, end: 1.3 }]
    expect(payloadStart(overlap, 'voice mum hi', 'hi')).toEqual({ t: 1, lo: 1, hi: 1 })
  })
  it('null when nothing can be placed', () => {
    expect(payloadStart([], T, 'I want')).toBeNull()
    expect(payloadStart(W, 'I want', 'I want')).toBeNull() // no head
    expect(payloadStart(W.slice(0, 2), T, 'I want a way')).toBeNull() // clip ends inside the head
    expect(payloadStart(W, T, '')).toBeNull()
  })

  // The same recording's 50 ms RMS envelope, idealised: speech ≈ −12 dB,
  // the pause between "console" and "I" ≈ −29 dB from 1.55 s to 2.20 s —
  // whisper put "I" at 1.94 s in one run and 2.40 s in another.
  const env = (quietFrom: number, quietTo: number, n = 200): Frame[] =>
    Array.from({ length: n }, (_, i) => { const t = i * 0.05; return { t, db: i < 2 ? -Infinity : t >= quietFrom && t < quietTo ? -29 + (i % 3) : -12 + (i % 5) } })
  it('snaps the words\' estimate to the real pause and cuts just before speech resumes', () => {
    expect(snapToGap(env(1.55, 2.2), { t: 1.79, lo: 1.58, hi: 1.94 })).toBe(2.1) // 2.20 − 0.10
    expect(snapToGap(env(1.55, 2.2), { t: 2.25, lo: 1.64, hi: 2.4 })).toBe(2.1) // the late run lands on the same cut
  })
  it('keeps the estimate when the envelope is flat, short, or shows no pause near the words', () => {
    const est = { t: 1.79, lo: 1.58, hi: 1.94 }
    expect(snapToGap(env(1.55, 2.2).map((f) => ({ ...f, db: -20 })), est)).toBe(1.79) // flat
    expect(snapToGap(env(1.55, 2.2).slice(0, 10), est)).toBe(1.79) // short
    expect(snapToGap(env(4, 4.5), est)).toBe(1.79) // a pause, but 2 s away
    expect(snapToGap(env(1.55, 1.65), est)).toBe(1.79) // two quiet frames are a plosive, not a pause
  })
  it('picks the run covering the words\' gap when several are near', () => {
    const two = env(1.55, 2.2).map((f) => (f.t >= 1.25 && f.t < 1.4 ? { ...f, db: -29 } : f)) // a 150 ms dip inside "console"
    expect(snapToGap(two, { t: 1.79, lo: 1.58, hi: 1.94 })).toBe(2.1)
  })
  it('parses ametadata output, -inf included', () => {
    expect(parseEnvelope('frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-inf\nframe:1    pts:800     pts_time:0.05\nlavfi.astats.Overall.RMS_level=-18.986382\n')).toEqual([{ t: 0, db: -Infinity }, { t: 0.05, db: -18.986382 }])
  })
})

describe('opus vendor patch (WhatsApp playability)', () => {
  /** A minimal ogg page: real header layout, correct CRC. */
  const page = (payload: Buffer, seq: number, type = 0): Buffer => {
    const lacing: number[] = []
    let rest = payload.length
    while (rest >= 255) { lacing.push(255); rest -= 255 }
    lacing.push(rest)
    const p = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(22), Buffer.from([lacing.length, ...lacing]), payload])
    p[4] = 0; p[5] = type
    p.writeUInt32LE(0xdeadbeef, 14) // serial
    p.writeUInt32LE(seq, 18)
    p.writeUInt32LE(oggCrc(p), 22)
    return p
  }
  const opusHead = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 1, 56, 1, 0x80, 0x3e, 0, 0, 0, 0, 0])]) // 16 kHz mono
  const opusTags = (vendor: string): Buffer => {
    const v = Buffer.from(vendor, 'utf8')
    const comment = Buffer.from('encoder=Lavc61', 'utf8')
    const out = Buffer.alloc(8 + 4 + v.length + 4 + 4 + comment.length)
    out.write('OpusTags', 0, 'latin1'); out.writeUInt32LE(v.length, 8); v.copy(out, 12)
    out.writeUInt32LE(1, 12 + v.length); out.writeUInt32LE(comment.length, 16 + v.length); comment.copy(out, 20 + v.length)
    return out
  }
  const audioPage = page(Buffer.from([0xf8, 1, 2, 3]), 2)

  it('replaces an Lavf vendor with "WhatsApp", drops comments, keeps a valid CRC, leaves other pages alone', () => {
    const ogg = Buffer.concat([page(opusHead, 0, 2), page(opusTags('Lavf60.16.100'), 1), audioPage])
    const patched = patchOpusVendor(ogg)
    expect(patched.includes('WhatsApp')).toBe(true)
    expect(patched.includes('Lavf60')).toBe(false)
    expect(patched.includes('encoder=Lavc61')).toBe(false)
    expect(patched.subarray(0, page(opusHead, 0, 2).length)).toEqual(page(opusHead, 0, 2)) // head page untouched
    expect(patched.subarray(patched.length - audioPage.length)).toEqual(audioPage) // audio untouched
    // the rebuilt tags page carries a self-consistent CRC
    const tagsOff = page(opusHead, 0, 2).length
    const rebuilt = Buffer.from(patched.subarray(tagsOff, patched.length - audioPage.length))
    const stored = rebuilt.readUInt32LE(22)
    rebuilt.writeUInt32LE(0, 22)
    expect(oggCrc(rebuilt)).toBe(stored)
    // idempotent-ish: patching again still yields WhatsApp
    expect(patchOpusVendor(patched).includes('WhatsApp')).toBe(true)
  })
  it('returns the input untouched when there is no tags page or the stream is not ogg', () => {
    expect(patchOpusVendor(Buffer.from('not ogg at all'))).toEqual(Buffer.from('not ogg at all'))
    const headOnly = page(opusHead, 0, 2)
    expect(patchOpusVendor(headOnly)).toEqual(headOnly)
  })
  it('pcmWaveform: 64 buckets scaled 0–100, silence is all zeros', () => {
    const loud = Buffer.alloc(640) // 320 samples: first half loud, second half near-silent
    for (let i = 0; i < 320; i++) loud.writeInt16LE(i < 160 ? 30000 : 300, i * 2)
    const w = pcmWaveform(loud)
    expect(w).toHaveLength(64)
    expect(Math.max(...w)).toBe(100)
    expect(w[0]).toBe(100)
    expect(w.at(-1)!).toBeLessThan(10)
    expect(pcmWaveform(Buffer.alloc(256))).toEqual(Array.from({ length: 64 }, () => 0))
  })
})

describe('llm fallback parsing', () => {
  it('accepts only on-schema replies with known targets', () => {
    expect(parseClassifyReply('{"kind":"agent","targetId":"s2","message":"buy milk"}', SCHEMA, ENV, 'x')).toBeNull() // no agent verb
    expect(parseClassifyReply('{"kind":"list","target":"dream","lead_in":"lock dreem"}', SCHEMA, ENV, 'lock dreem flying')).toMatchObject({ kind: 'list', file: 'scratch/lists/dream.md', dated: true, item: 'flying' })
    expect(parseClassifyReply('{"kind":"list","target":"food","lead_in":"lock"}', SCHEMA, ENV, 'lock eggs')).toBeNull()
    expect(parseClassifyReply('{"kind":"list","target":"movies","lead_in":"at flims"}', SCHEMA, ENV, 'at flims Dune')).toMatchObject({ kind: 'list', enrich: 'movie', dated: false, item: 'Dune' })
    expect(parseClassifyReply('{"kind":"echo","lead_in":"ecko"}', SCHEMA, ENV, 'ecko hi')).toEqual({ kind: 'echo', text: 'hi' })
    expect(parseClassifyReply('{"kind":"card","project":"console","lead_in":"consul"}', SCHEMA, ENV, 'consul fix')).toMatchObject({ kind: 'card', column: 'Backlog', text: 'fix' })
    expect(parseClassifyReply('{"kind":"card","project":"console","lead_in":"consul","start":true}', SCHEMA, ENV, 'consul fix')).toMatchObject({ kind: 'card', column: 'In Progress' })
    expect(parseClassifyReply('{"kind":"card","project":"nope","lead_in":"nope"}', SCHEMA, ENV, 'nope fix')).toBeNull()
    expect(parseClassifyReply('{"kind":"message","contact":"nica","lead_in":"massage nika"}', SCHEMA, ENV, 'massage nika hi')).toMatchObject({ kind: 'message', contact: 'nica', text: 'hi' })
    expect(parseClassifyReply('{"kind":"message","contact":"al","lead_in":"massage owl"}', SCHEMA, ENV, 'massage owl hi')).toMatchObject({ kind: 'message', contact: 'al' }) // a real send to AL's DM, not rerouted
    expect(parseClassifyReply('{"kind":"voice","contact":"nica","lead_in":"Voys note for Nika,"}', SCHEMA, ENV, "Voys note for Nika, I'm late")).toEqual({ kind: 'voice', contact: 'nica', spoken: 'nica', text: "I'm late" })
    expect(parseClassifyReply('{"kind":"voice","contact":"nica","lead_in":"Voice Nica"}', SCHEMA, ENV, "voys nika I'm late")).toBeNull() // lead-in not a prefix: never send the command words
    expect(buildClassifyPrompt('x', SCHEMA, ENV)).toMatch(/"kind":"voice".*VOICE note/)
    expect(buildClassifyPrompt('x', SCHEMA, ENV)).toMatch(/"contact":"<one of: .*control room/) // rooms are recipients too
    expect(parseClassifyReply('{"kind":"voice","contact":"control room","lead_in":"Voys, control room."}', SCHEMA, ENV, 'Voys, control room. This is a test.')).toEqual({ kind: 'voice', contact: 'control room', spoken: 'control room', text: 'This is a test' })
    expect(parseClassifyReply('{"kind":"message","contact":"some room","lead_in":"message some room"}', SCHEMA, ENV, 'message some room hi')).toBeNull() // off-schema room
    expect(parseClassifyReply('{"kind":"music","action":"louder"}', SCHEMA, ENV, 'x')).toBeNull()
    expect(parseClassifyReply('{"kind":"unknown"}', SCHEMA, ENV, 'raw')).toEqual({ kind: 'unknown', text: 'raw' })
    expect(parseClassifyReply('I cannot help', SCHEMA, ENV, 'x')).toBeNull()
  })
  it('prompt carries the tree, roster and transcript verbatim — and asks for a lead-in, never the payload', () => {
    const p = buildClassifyPrompt('tel owl buy "milk"', SCHEMA, ENV)
    expect(p).not.toContain('"agent"')
    expect(p).toContain('one of: dream')
    expect(p).toContain('yasmina-amar←mum/sister/yasmina')
    expect(p).toContain(JSON.stringify('tel owl buy "milk"'))
    expect(p).toContain('"lead_in"')
    expect(p).not.toContain('"item"')
    expect(p).toMatch(/never summarise, rewrite/i)
  })
  it('the dream: the payload is the transcript minus the lead-in, word for word', () => {
    expect(DREAM.transcription.split(/\s+/).length).toBeGreaterThan(150)
    const c = parseClassifyReply(`{"kind":"list","target":"dream","lead_in":${JSON.stringify(DREAM_LEAD_IN)}}`, SCHEMA, ENV, DREAM.transcription)
    expect(c).toMatchObject({ kind: 'list', target: 'dream', dated: true })
    expect((c as { item: string }).item).toBe(DREAM_BODY)
    expect((c as { item: string }).item.startsWith('I had a dream that first I ordered some nice food')).toBe(true)
    expect((c as { item: string }).item.endsWith('from one card to another and')).toBe(true)
  })
  it('the dream: the summary the model actually wrote is refused', () => {
    const summary = DREAM.route.command.item // "Ordered food to house, picked it up from library window, …"
    expect(summary.split(' ').length).toBeLessThan(50)
    expect(parseClassifyReply(`{"kind":"list","target":"dream","item":${JSON.stringify(summary)}}`, SCHEMA, ENV, DREAM.transcription)).toBeNull()
    expect(parseClassifyReply('{"kind":"card","project":"console","text":"fix the misaligned login button"}', SCHEMA, ENV, 'the login button is misaligned, fix it')).toBeNull()
    expect(parseClassifyReply('{"kind":"message","contact":"nica","text":"running late"}', SCHEMA, ENV, "massage nika I'm going to be late")).toBeNull()
  })
  it('payload rules: verbatim legacy item ok; lead-in mismatch → whole transcript for logs/cards/echo, refused for a message; lead-in eating everything → nothing', () => {
    expect(parseClassifyReply('{"kind":"list","target":"dream","item":"I was flying"}', SCHEMA, ENV, 'Log dreem I was flying.')).toMatchObject({ item: 'I was flying' })
    expect(parseClassifyReply('{"kind":"list","target":"dream","lead_in":"Log dreams."}', SCHEMA, ENV, 'Lock dreem, I was flying.')).toMatchObject({ item: 'Lock dreem, I was flying' })
    expect(parseClassifyReply('{"kind":"card","project":"console","lead_in":"Console please."}', SCHEMA, ENV, 'Consul: the login button is misaligned')).toMatchObject({ text: 'Consul: the login button is misaligned' })
    expect(parseClassifyReply('{"kind":"echo"}', SCHEMA, ENV, 'ecko testing')).toEqual({ kind: 'echo', text: 'ecko testing' })
    expect(parseClassifyReply('{"kind":"message","contact":"nica","lead_in":"Message Nica"}', SCHEMA, ENV, "massage nika I'm late")).toBeNull()
    expect(parseClassifyReply('{"kind":"message","contact":"nica"}', SCHEMA, ENV, "massage nika I'm late")).toBeNull()
    expect(parseClassifyReply('{"kind":"message","contact":"nica","lead_in":"massage nika"}', SCHEMA, ENV, "massage nika I'm late")).toMatchObject({ kind: 'message', text: "I'm late" })
    expect(parseClassifyReply('{"kind":"list","target":"dream","lead_in":"log dream"}', SCHEMA, ENV, 'Log dream.')).toBeNull()
    expect(parseClassifyReply('{"kind":"music","action":"play","query":"Taylor Swift"}', SCHEMA, ENV, 'put on some Taylor Swift please')).toEqual({ kind: 'music', action: 'play', query: 'Taylor Swift' })
    expect(parseClassifyReply('{"kind":"music","action":"play","query":"Taylor Swift"}', SCHEMA, ENV, 'put on some tailor swift please')).toBeNull()
    expect(payloadFor('Okay so, log dream I flew', 'Okay so, log dream', '', true)).toBe('I flew') // fillers stripped on both sides
  })
})

describe('lead-in / verbatim helpers', () => {
  it('stripLeadIn: word-wise prefix, punctuation and case ignored, null when not a prefix', () => {
    expect(stripLeadIn(normaliseKeepCase(DREAM.transcription), DREAM_LEAD_IN)).toBe(DREAM_BODY)
    expect(stripLeadIn('Log dream. I was flying', 'log dream')).toBe('I was flying')
    expect(stripLeadIn("Message Nica — I'm late", 'Message Nica')).toBe("I'm late")
    expect(stripLeadIn('Log dream. I was flying', 'Log dreams')).toBeNull()
    expect(stripLeadIn('Log dream', 'Log dream.')).toBe('')
    expect(stripLeadIn('Log dream', '')).toBeNull()
  })
  it('isVerbatim / findWordRun / wordKeys', () => {
    expect(wordKeys('Look, these are three dreams.')).toEqual(['look', 'these', 'are', 'three', 'dreams'])
    expect(isVerbatim('these are three dreams', DREAM.transcription)).toBe(true)
    expect(isVerbatim('I had peach iced tea', DREAM.transcription)).toBe(true)
    expect(isVerbatim('peach tea', DREAM.transcription)).toBe(false)
    expect(isVerbatim('', 'x')).toBe(false)
    expect(findWordRun(['a', 'b', '', 'c'], ['b', 'c'])).toBe(1) // empty (dash) keys are skipped
    expect(findWordRun(['a', 'b', 'c'], ['b', 'c'], 0)).toBe(-1) // beyond maxStart
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
      { kind: 'skip', retry: true, alert: true, reason: 'no product matched "unobtainium"' },
    ])
    const seq = f.calls.map((c) => c.args.slice(0, 2).join(' '))
    expect(seq).toEqual(['order status', 'order amend', 'product search', 'basket add', 'product search', 'basket add', 'product search', 'checkout --yes'])
    expect(f.calls.find((c) => c.args[0] === 'basket')!.args).toEqual(['basket', 'add', '111', '-q', '1', '--slot-booked'])
    expect(f.calls.filter((c) => c.args[0] === 'checkout')).toHaveLength(1)
  })
  it('searches the LLM\'s plain product term, picks with the spoken qualifiers (2026-09-07: "kitty litter, the big one" found only "The Big One" pods)', async () => {
    const f = fakeSainsburys(OPEN, { searchHits: {
      'kitty litter, the big one': [{ product_uid: '8215801', name: 'Fairy Non Bio The Big One Pods 21 Washes' }],
      'cat litter': [{ product_uid: '8111841', name: 'Cat Litter Non Clumping 10L' }, { product_uid: '2533407', name: 'Catsan Odour Control Cat Litter 20L' }],
    } })
    const prompts: string[] = []
    const llm = async (p: string) => {
      prompts.push(p)
      if (p.includes('"query"')) return '{"query": "cat litter"}'
      if (p.includes('none fits')) return p.includes('20L') ? '{"index": 1}' : '{"index": null}'
      return null
    }
    const out = await g.run([{ item: 'kitty litter, the big one' }], { llm, exec: f.exec, log: () => {} })
    expect(out).toEqual([{ kind: 'remove', note: 'kitty litter, the big one → Catsan Odour Control Cat Litter 20L (order 1342297016)', logTo: GROCERIES_ORDERED_LOG }])
    expect(f.calls.find((c) => c.args[1] === 'search')!.args[2]).toBe('cat litter')
    expect(prompts.find((p) => p.includes('none fits'))).toContain('"kitty litter, the big one"')
    // LLM down → the spoken words are the search term, as before.
    const g2 = fakeSainsburys(OPEN, { searchHits: { eggs: [{ product_uid: '1', name: 'Eggs' }] } })
    expect(await g.run([{ item: 'eggs' }], { llm: async () => null, exec: g2.exec, log: () => {} })).toMatchObject([{ kind: 'remove' }])
    // Nothing matched even with the plain term → alert, reason names both.
    const g3 = fakeSainsburys(OPEN)
    expect(await g.run([{ item: 'kitty litter, the big one' }], { llm, exec: g3.exec, log: () => {} })).toEqual([{ kind: 'skip', retry: true, alert: true, reason: 'no product matched "kitty litter, the big one" (searched "cat litter")' }])
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

  it('boot sweep: a row written while the hub was down is enriched on start(), with no file event', async () => {
    const store = new NoteStore(dir, join(dir, 'tomb.json'))
    mkdirSync(join(dir, 'lists'), { recursive: true })
    writeFileSync(join(dir, 'lists', 'movies.md'), appendRow(null, columnsFor('movie'), rawRow('movie', 'dune', '2026-09-06 10:47')))
    const calls: string[] = []
    const w = new ListWatcher(store, { targets, deps: { llm: async (p) => { calls.push(p); return '{"title":"Dune","year":"2021","series":"No"}' }, exec: noExec }, log: () => {}, now: () => Date.now() + 10_000, quietMs: 5_000 })
    await w.start()
    w.stop()
    expect(calls).toHaveLength(1)
    expect(readFileSync(join(dir, 'lists', 'movies.md'), 'utf8')).toMatch(/\| Dune\s+\| 2021 \|/)
  })

  it('a stuck grocery row pushes ONCE while an order is open; hourly retries stay silent; draining clears it', async () => {
    const store = new NoteStore(dir, join(dir, 'tomb.json'))
    mkdirSync(join(dir, 'lists'), { recursive: true })
    writeFileSync(join(dir, 'lists', 'groceries.md'), appendRow(null, columnsFor('grocery-order'), rawRow('grocery-order', 'unobtainium', '2026-09-06 10:47')))
    let hits: object[] = []
    const exec: EnricherDeps['exec'] = async (_cmd, args) => {
      const sub = args.slice(0, 2).join(' ')
      if (sub === 'order status') return { code: 0, stdout: JSON.stringify({ active: true, order_uid: '42', is_in_amend_mode: true, is_cutoff: false }), stderr: '' }
      if (sub === 'product search') return { code: 0, stdout: JSON.stringify({ products: hits }), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const pushes: Array<{ title: string; body: string; id: string }> = []
    const w = new ListWatcher(store, { targets, deps: { llm: async (p) => (p.includes('none fits') ? '{"index": 0}' : null), exec }, notify: (m) => pushes.push(m), log: () => {}, now: () => new Date(2026, 8, 6, 11, 0).getTime(), quietMs: 0 })
    expect(await w.runNow()).toBe(0)
    expect(await w.runNow()).toBe(0)
    expect(pushes).toEqual([{ title: 'Groceries: unobtainium', body: 'Not added: no product matched "unobtainium"', id: 'lists:groceries:unobtainium' }])
    hits = [{ product_uid: '1', name: 'Unobtainium 1kg' }]
    expect(await w.runNow()).toBe(1)
    expect(pushes).toHaveLength(1)
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
    expect(add.targets.find((t) => t.name === 'al')).toMatchObject({ ok: true, aliases: ['l', 'el', 'owl', 'hal'], resolves: 'board card → Backlog' })
    expect(d.verbs.find((v) => v.verb === 'start')!.targets.find((t) => t.name === 'al')).toMatchObject({ ok: true, aliases: ['l', 'el', 'owl', 'hal'] })
    const ghost = await describeSchema({ schema: { ...SCHEMA, projects: { ghost: ['g'] } }, errors: [], stale: false, path: 'p.md' }, { ...ENV, agents: AGENTS, echoConfigured: false }, async () => true)
    expect(ghost.verbs.find((v) => v.verb === 'add')!.targets.find((t) => t.name === 'ghost')).toMatchObject({ ok: false, note: /no project with a board/ })
    expect(add.targets.find((t) => t.name === 'dream')!.resolves).toMatch(/^log scratch\/lists\/dream.md/)
    const msg = d.verbs.find((v) => v.verb === 'message')!
    expect(msg.targets.find((t) => t.name === 'yasmina-amar')).toMatchObject({ ok: true, aliases: ['mum', 'sister', 'yasmina'] }) // 'yasmina' listed explicitly here, so not doubled
    expect(msg.targets.find((t) => t.name === 'al')).toMatchObject({ ok: true, resolves: "AL's own WhatsApp DM (as Yousef)" })
    expect(msg.targets.find((t) => t.name === 'control room')).toMatchObject({ ok: true, aliases: ['control'], resolves: 'chat room by name (as Yousef)' })
    expect(msg.targets.find((t) => t.name === 'yes theory london fam')).toMatchObject({ ok: false, note: 'no chat room has this name' })
    expect(d.verbs.find((v) => v.verb === 'voice')!.targets.map((t) => t.name)).toContain('control room')
    expect(d.verbs.find((v) => v.verb === 'echo')!.note).toMatch(/NOTIFY_JID unset/)
    const voice = d.verbs.find((v) => v.verb === 'voice')!
    expect(voice).toMatchObject({ aliases: ['voicenote', 'audio'], note: /voice note/ })
    expect(voice.targets.map((t) => t.name)).toEqual(msg.targets.map((t) => t.name))
    expect(d.verbs.map((v) => v.verb)).toEqual(['add', 'start', 'message', 'voice', 'echo', 'music', 'timer', 'remind'])
  })
})

describe('RingStore + pipeline', () => {
  let dir: string
  let store: RingStore
  let toAl: string[]
  let toAgent: Array<{ key: string; content: string }>
  let echoed: string[]
  let sentAsYousef: Array<{ contact: string; text: string }>
  let voiceSent: Array<{ contact: string; clip: VoiceClip }>
  let cuts: Array<{ path: string; from: number }>
  let timedWords: TimedWord[] | null
  let envelope: Frame[] | null
  let missCards: Array<{ text: string; column: string }>
  let notified: Array<{ title: string; body: string }>
  let music: string[]
  let timers: Array<number | null>
  let reminders: Array<{ text: string; dueAt: number; recordingId: string }>
  let notes: Map<string, string>
  let cards: string[]
  let heads: Array<{ path: string; vocabulary: string }>
  let durationMs: number | null
  let schema: RingSchema
  let ctx: RingCtx

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ring-'))
    store = new RingStore(dir)
    toAl = []; toAgent = []; echoed = []; sentAsYousef = []; voiceSent = []; cuts = []; timedWords = null; envelope = null; missCards = []; notified = []; music = []; cards = []; timers = []; reminders = []; heads = []; durationMs = null
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
      chatSendVoiceAsYousef: async (contact, clip) => { if (contact === 'nobody') throw new Error('no WhatsApp DM room found for nobody'); voiceSent.push({ contact, clip }); return `${contact} (dm)` },
      voiceAudio: {
        words: async () => timedWords,
        envelope: async () => envelope,
        cut: async (path, from) => { cuts.push({ path, from }); return { data: Buffer.from(`ogg-from-${from}`), contentType: 'audio/ogg', durationMs: Math.round((21.3 - from) * 1000) } },
      },
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
      reminders: {
        schedule: (text, dueAt, recordingId) => { reminders.push({ text, dueAt, recordingId }); return { id: 'ab12', text, dueAt, createdAt: 0, attempts: 0, recordingId } },
        pending: () => [],
        cancel: () => true,
      },
      transcribe: async () => 'weather from stt',
      transcribeHead: async (path, vocabulary) => { heads.push({ path, vocabulary }); return null },
      audioDuration: async () => durationMs,
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

  it('flags a recording the app re-stamped with its recovery time as synced late', async () => {
    // 16 Sep 2026: a 120 s dream made at 04:56Z arrived stamped 05:21:31Z and
    // was received at 05:21:44Z — 13 s after a 120 s recording "started".
    durationMs = 120_128
    const late = await processDelivery(ctx, { transcription: 'Log dream. Three dreams.', audio: { data: Buffer.from('m4a'), contentType: 'audio/mp4' }, recordedAt: Date.now() - 13_000, client: 'ring' })
    expect(late.audio?.durationMs).toBe(120_128)
    expect(late.syncedLate).toBe(true)
    expect(notified.at(-1)?.title).toBe('Ring · log dream · synced late')
    expect(JSON.parse(readFileSync(join(dir, 'ring', 'recordings', `${late.id}.json`), 'utf8'))).toMatchObject({ syncedLate: true, audio: { durationMs: 120_128 } })

    durationMs = 3_328
    const live = await processDelivery(ctx, { transcription: 'Log dream. Short one.', audio: { data: Buffer.from('m4a'), contentType: 'audio/mp4' }, recordedAt: Date.now() - 15_000, client: 'ring' })
    expect(live.audio?.durationMs).toBe(3_328)
    expect(live.syncedLate).toBeUndefined()
    expect(notified.at(-1)?.title).toBe('Ring · log dream')

    // `con ring say` has no audio and no recordedAt — nothing to judge.
    const say = await deliver('log dream said one')
    expect(say.syncedLate).toBeUndefined()
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

  it('remind schedules a hub reminder due from the spoken time and the clock now; the push says when', async () => {
    const rec = await deliver('remind me to take the ring off')       // now = 23:07 → 01:07 tomorrow
    expect(rec.route).toMatchObject({ rule: 'remind.default', ok: true, detail: 'tomorrow 01:07 → WhatsApp (ab12)' })
    expect(reminders).toEqual([{ text: 'to take the ring off', dueAt: new Date(2026, 8, 3, 1, 7).getTime(), recordingId: rec.id }])
    expect(notified[0]).toMatchObject({ title: 'Ring · reminder tomorrow 01:07 → WhatsApp (ab12)', body: 'to take the ring off' })
    await deliver('remind me at 5 to leave')                          // 05:00 and 17:00 both gone → 05:00 tomorrow
    expect(reminders[1]).toMatchObject({ text: 'to leave', dueAt: new Date(2026, 8, 3, 5, 0).getTime() })
    ctx.reminders.schedule = () => { throw new Error('reminders file unwritable') }
    expect((await deliver('remind me to fail')).route).toMatchObject({ ok: false, detail: 'reminders file unwritable' })
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

  it('voice sends the RECORDING as a voice note from Yousef\'s account, cut where the payload starts', async () => {
    // Whisper over the head clip: "Voice mum." ends at 1.58 s, "I'll" starts at 1.94 s.
    timedWords = [{ word: 'Voice', start: 0, end: 0.8 }, { word: 'mum.', start: 0.84, end: 1.58 }, { word: "I'll", start: 1.94, end: 2.2 }, { word: 'be', start: 2.2, end: 2.4 }, { word: 'home', start: 2.4, end: 2.9 }]
    const rec = await processDelivery(ctx, { transcription: "Voice mum. I'll be home in 30 mins.", audio: { data: Buffer.from('m4a'), contentType: 'audio/mp4' }, recordedAt: 1756800000000, client: 'ring' })
    expect(rec.route).toMatchObject({ rule: 'voice', ok: true, detail: 'yasmina-amar (dm), 00:20, head cut at 1.79s', command: { kind: 'voice', contact: 'yasmina-amar', text: "I'll be home in 30 mins" } })
    expect(cuts).toEqual([{ path: rec.audio!.path, from: 1.79 }])
    expect(voiceSent).toEqual([{ contact: 'yasmina-amar', clip: { data: Buffer.from('ogg-from-1.79'), contentType: 'audio/ogg', durationMs: 19510 } }])
    expect(sentAsYousef).toHaveLength(0)
    expect(toAl).toHaveLength(0)
    expect(notified[0]).toMatchObject({ title: 'Ring → mum · voice note (yasmina-amar (dm), 00:20, head cut at 1.79s)', body: "I'll be home in 30 mins" })
    // With the signal's envelope the cut snaps to the real pause (quiet 1.55–2.20 s).
    envelope = Array.from({ length: 200 }, (_, i) => { const t = i * 0.05; return { t, db: t >= 1.55 && t < 2.2 ? -29 : -12 } })
    await processDelivery(ctx, { transcription: "Voice mum. I'll be home in 30 mins.", audio: { data: Buffer.from('m4a'), contentType: 'audio/mp4' }, recordedAt: 1756800001000, client: 'ring' })
    expect(cuts.at(-1)!.from).toBe(2.1)
  })

  it('voice without word timestamps ships the whole recording and says so; typed text has no recording to send', async () => {
    timedWords = null
    const rec = await processDelivery(ctx, { transcription: 'voice nika running late', audio: { data: Buffer.from('m4a'), contentType: 'audio/mp4' }, recordedAt: null, client: 'ring' })
    expect(rec.route).toMatchObject({ ok: true, detail: 'nica (dm), 00:21, UNCUT — command words included' })
    expect(cuts).toEqual([{ path: rec.audio!.path, from: 0 }])
    const typed = await deliver('voice nika running late')
    expect(typed.route).toMatchObject({ ok: false, detail: expect.stringMatching(/no recording to send/) })
    expect(voiceSent).toHaveLength(1)
    expect(missCards.at(-1)!.text).toMatch(/^Ring miss: "voice nika running late"/)
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
    expect((await deliver('book me a table for two')).route).toMatchObject({ via: 'default', ok: true, command: { kind: 'fallback', agentKey: 'al' } })
    schema.fallback = 'console-general'
    expect((await deliver('book me a table for two')).route).toMatchObject({ via: 'default', ok: true })
    expect(toAgent.at(-1)!.key).toBe('console-general')
    schema.fallback = 'dead'
    expect((await deliver('book me a table for two')).route).toMatchObject({ via: 'default', ok: false, detail: '@dead is not live' })
    schema.fallback = null; schema.llmFallback = false
    const none = await deliver('book me a table for two')
    expect(none.route).toMatchObject({ via: 'none', ok: false, command: { kind: 'unknown' } })
    expect(none.route?.card).toBeUndefined() // no fallback configured is a choice, not a miss
    expect(notified.at(-1)!.title).toBe('Ring: not delivered')
  })

  const M4A = { data: Buffer.from('fake-m4a-bytes'), contentType: 'audio/mp4' }
  const deliverRing = (transcription: string) => processDelivery(ctx, { transcription, audio: M4A, recordedAt: null, client: 'ring' })

  it('the dream, end to end: the mis-heard head is re-heard by hub STT and the ring transcript is logged verbatim from there', async () => {
    ctx.transcribeHead = async (path, vocabulary) => { heads.push({ path, vocabulary }); return DREAM_HEAD }
    const rec = await deliverRing(DREAM.transcription)
    expect(rec.route).toMatchObject({ via: 'rule', rule: 'add.log', head: DREAM_HEAD, ok: true, command: { kind: 'list', target: 'dream' } })
    const item = `these are three dreams. ${DREAM_BODY}`
    expect((rec.route!.command as { item: string }).item).toBe(item)
    expect(notes.get('scratch/lists/dream.md')).toBe(`## 2026-09-02\n- 23:07 ${item}\n`)
    expect(heads).toHaveLength(1)
    expect(heads[0]!.path).toBe(rec.audio!.path)
    expect(heads[0]!.vocabulary).toContain('Log dream.')
    expect(JSON.parse(readFileSync(join(dir, 'ring', 'recordings', `${rec.id}.json`), 'utf8')).route.head).toBe(DREAM_HEAD)
  })

  it('no re-hearing (STT down) → the first-sentence rescue stands; a re-hearing that cannot be aligned is ignored', async () => {
    const rec = await deliverRing(DREAM.transcription)
    expect(rec.route).toMatchObject({ via: 'rule', rule: 'add.log-sentence', ok: true })
    expect(rec.route!.head).toBeUndefined()
    expect((rec.route!.command as { item: string }).item).toBe(DREAM_BODY)
    ctx.transcribeHead = async () => 'Log dream. Those were three dreams and then'
    expect((await deliverRing(DREAM.transcription)).route).toMatchObject({ rule: 'add.log-sentence' })
  })

  it('the head is re-heard only when the rules did not firmly match, only on ring transcripts with audio, and before the LLM', async () => {
    await deliverRing('log dream I was escaping a prison made of cheese')
    expect(heads).toHaveLength(0) // firm match
    await deliver('uh skippity doo')
    expect(heads).toHaveLength(0) // no audio (simulated)
    await processDelivery(ctx, { transcription: null, audio: M4A, recordedAt: null, client: 'ring' })
    expect(heads).toHaveLength(0) // hub-stt transcript already IS the re-hearing
    await deliverRing('log food two eggs')
    expect(heads).toHaveLength(1) // unknown-target is not firm
    let classified = 0
    ctx.classify = async () => { classified++; return null }
    ctx.transcribeHead = async () => 'Pause the music.'
    expect((await deliverRing('Paws the music.')).route).toMatchObject({ rule: 'music.pause', head: 'Pause the music.', ok: true })
    expect(classified).toBe(0)
    ctx.transcribeHead = async () => "Message Nica, I'll be home in 30 minutes, maybe"
    const msg = await deliverRing("Massive Nika. I'll be home in 30 minutes, maybe 40.") // "massive" is two edits off any verb — the rules miss
    expect(msg.route).toMatchObject({ rule: 'message', head: expect.stringContaining('Message Nica'), command: { contact: 'nica', text: "I'll be home in 30 minutes, maybe 40" } })
    expect(sentAsYousef.at(-1)).toEqual({ contact: 'nica', text: "I'll be home in 30 minutes, maybe 40" })
  })

  it('spliceHeadPayload + sttVocabulary', () => {
    expect(spliceHeadPayload({ kind: 'music', action: 'pause' }, 'anything')).toEqual({ kind: 'music', action: 'pause' })
    expect(spliceHeadPayload({ kind: 'echo', text: 'one two three four' }, 'Ecko! one, two, three, four, five')).toEqual({ kind: 'echo', text: 'one, two, three, four, five' })
    expect(spliceHeadPayload({ kind: 'echo', text: 'six seven' }, 'Ecko! one two three')).toBeNull()
    expect(spliceHeadPayload({ kind: 'echo', text: '' }, 'Ecko! one two three')).toBeNull()
    const vocab = sttVocabulary(SCHEMA, ENV)
    expect(vocab).toContain('Log dream.')
    expect(vocab).toContain('Add movies.')
    expect(vocab).toContain('Add reflection tools.')
    expect(vocab).toContain('Message Yasmina.')
    expect(vocab).not.toContain('dreem') // aliases are mis-hearings, never primed
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
