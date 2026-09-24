// Ring command router — PURE string parsing, no LLM. A transcript from the
// Pebble Index 01 becomes a RingCommand by walking the command tree in
// schema.ts (`<verb> <target> <payload>`), with tolerance for
// mis-transcription: explicit aliases from the schema note plus a one-edit
// fuzzy match on words of 4+ letters. The LLM (llm-fallback.ts) is consulted
// only when nothing here matches. Keep every rule deterministic and testable.
//
// There is deliberately NO "agent <name>" verb: Yousef talks to PROJECTS
// (`add <project> …` files a card, the board forks an agent for it), not to
// agents. AL is reached only as the fallback for text no verb claims.

import { spokenForms, recipientForms, projectForms, AL_CONTACT, type RingSchema, type ListTarget } from './schema.js'
import { parseDuration, formatDuration } from '../glasses/timer.js'
import { parseReminder, describeWhen, type ReminderWhen } from './remind.js'

/** What the router can see besides the transcript — all resolved by the hub. */
export interface RouteEnv {
  /** Vault project slugs (an `add` target naming one files a board card). */
  projects: string[]
  /** AL workspace usernames (users/<name>.md) for `message`. */
  contacts: string[]
  /** Chat room names, lowercased — only for checking the note's `rooms:` resolve. */
  rooms: string[]
}

export type RingCommand =
  /** Append to a list/log note. `dated` = log semantics (day heading + HH:MM). */
  | { kind: 'list'; target: string; file: string; item: string; dated: boolean; enrich?: ListTarget['enrich'] }
  | { kind: 'echo'; text: string }
  | { kind: 'card'; project: string; column: string; text: string }
  /** `contact` is the recipient's canonical: a users/<name>.md username, AL,
   *  or a `rooms:` key (a chat room's name) — the ctx resolves each its way. */
  | { kind: 'message'; contact: string; spoken: string; text: string }
  /** The recording itself, minus the command head, as a voice note. `text`
   *  is the payload transcript — it anchors the cut and captions the push. */
  | { kind: 'voice'; contact: string; spoken: string; text: string }
  /** `text` into the recipient's chat composer as an UNSENT draft — Yousef
   *  edits and sends it himself. Same recipients as `message`. */
  | { kind: 'draft'; contact: string; spoken: string; text: string }
  /** Only ever minted by the FALLBACK (unclaimed text → the fallback agent) —
   *  there is no spoken "agent" verb: Yousef talks to projects (`add <project>
   *  …` forks a card), not to agents. */
  | { kind: 'fallback'; agentKey: string; text: string }
  | { kind: 'music'; action: 'play' | 'pause' | 'next' | 'previous'; query?: string }
  /** The glasses' native countdown (0x07): `seconds` runs one, null cancels. */
  | { kind: 'timer'; seconds: number | null; spoken: string }
  /** `text` to Yousef's own WhatsApp when `when` comes round. `spoken` is the
   *  time phrase as said; null = the schema's default delay applied. */
  | { kind: 'remind'; text: string; when: ReminderWhen; spoken: string | null }
  /** A verb matched but its target didn't — actionable feedback, not a fallback. */
  | { kind: 'unknown-target'; verb: string; target: string; text: string }
  | { kind: 'unknown'; text: string }

export interface RouteMatch {
  command: RingCommand
  /** Which rule fired — surfaces in the recording metadata for schema tuning. */
  rule: string
  /** A heuristic rescue (the target was found inside the first sentence, not
   *  in the head slot) — the pipeline lets a re-hearing of the audio head
   *  override it before accepting. */
  weak?: true
}

const FILLERS = /^(?:hey|hi|ok|okay|um|uh|so|please|right|yeah)[,.]?\s+/i

/** Everything `normalise` does except case-folding, so payloads keep the
 *  speaker's capitalisation (a dream log shouldn't read all-lowercase).
 *  Word boundaries are identical between the two forms. */
export function normaliseKeepCase(text: string): string {
  let t = text.normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim()
  t = t.replace(/^[,.!?;:\s]+/, '').replace(/[.!?,;:\s]+$/, '')
  for (let i = 0; i < 3; i++) {
    const next = t.replace(FILLERS, '')
    if (next === t) break
    t = next
  }
  return t
}

export function normalise(text: string): string {
  return normaliseKeepCase(text).toLowerCase()
}

/** A token's comparison key: lowercased, surrounding punctuation dropped, so
 *  "Dream." ≡ "dream" and "I’m" ≡ "I'm". Empty for a bare dash/punctuation. */
export function wordKey(token: string): string {
  return token.toLowerCase().replace(/[‘’]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

export function wordKeys(text: string): string[] {
  return text.split(/\s+/).map(wordKey).filter(Boolean)
}

/** Index in `hay` where `needle` occurs as a contiguous run (starting at or
 *  before `maxStart`), or -1. Empty keys in `hay` are skipped over. */
export function findWordRun(hay: string[], needle: string[], maxStart = Infinity): number {
  if (!needle.length) return -1
  const idx = hay.map((k, i) => (k ? i : -1)).filter((i) => i >= 0)
  for (let s = 0; s < idx.length && idx[s]! <= maxStart; s++) {
    if (s + needle.length > idx.length) break
    let ok = true
    for (let j = 0; j < needle.length; j++) if (hay[idx[s + j]!] !== needle[j]) { ok = false; break }
    if (ok) return idx[s]!
  }
  return -1
}

/** `candidate` is a verbatim stretch of `text` (word for word, case and
 *  punctuation aside). What the LLM classifier's payloads must satisfy. */
export function isVerbatim(candidate: string, text: string): boolean {
  return findWordRun(wordKeys(text), wordKeys(candidate)) >= 0
}

/** Cut a spoken lead-in ("Log dream.", "Look, these are three dreams.") off
 *  the front of an utterance, word by word with case and punctuation
 *  ignored. Null when the lead-in is not actually a prefix; an empty string
 *  when it consumed everything. */
export function stripLeadIn(utterance: string, leadIn: string): string | null {
  const lead = wordKeys(leadIn)
  if (!lead.length) return null
  const tokens = utterance.split(' ')
  let i = 0
  for (let li = 0; li < lead.length;) {
    if (i >= tokens.length) return null
    const k = wordKey(tokens[i++]!)
    if (!k) continue
    if (k !== lead[li]) return null
    li++
  }
  while (i < tokens.length && !wordKey(tokens[i]!)) i++
  return tokens.slice(i).join(' ').replace(/^[,.;:!?…\s]+/, '')
}

/** Optimal-string-alignment edit distance (Levenshtein + adjacent
 *  transposition as ONE edit), capped early at `max + 1`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, i) => i)]
  for (let i = 1; i <= a.length; i++) {
    const prev = rows[i - 1]!
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    rows.push(cur)
  }
  return rows[a.length]![b.length]!
}

/** Spoken word ≈ known word: exact, or one edit apart when both have 4+ letters. */
export function fuzzyEqual(spoken: string, known: string): boolean {
  if (spoken === known) return true
  if (spoken.length < 4 || known.length < 4) return false
  return editDistance(spoken, known, 1) <= 1
}

/** Pick the best of `candidates` for `spoken`: exact beats fuzzy; among fuzzy
 *  hits, a unique one wins, ambiguity loses (never guess between two). */
export function pickFuzzy(spoken: string, candidates: string[]): string | null {
  if (candidates.includes(spoken)) return spoken
  const fuzzy = candidates.filter((c) => fuzzyEqual(spoken, c))
  return fuzzy.length === 1 ? fuzzy[0]! : null
}

/** Resolve a spoken form through an alias table (spoken → canonical). Fuzzy
 *  hits on two forms of the SAME canonical still count as unique. */
export function resolveSpoken(spoken: string, forms: Map<string, string>): string | null {
  const exact = forms.get(spoken)
  if (exact) return exact
  const hits = new Set<string>()
  for (const [form, canonical] of forms) if (fuzzyEqual(spoken, form)) hits.add(canonical)
  return hits.size === 1 ? [...hits][0]! : null
}

const MESSAGE_LEAD = /^(?:to|that)\s+/i
/** "voice NOTE mum", "voice message TO mum" — verb-phrase words the person
 *  may sit behind. Skipped one at a time, never more than this many. `of`:
 *  the ring's STT wrote "Voice Yasin" as "Voice of Yasin" (^jade-hawk). */
const VOICE_PHRASE = new Set(['note', 'message', 'memo', 'to', 'for', 'of'])
const VOICE_PHRASE_MAX = 2
/** "draft A MESSAGE TO mum", "draft a reply for mum" — three words at most. */
const DRAFT_PHRASE = new Set(['a', 'message', 'text', 'reply', 'note', 'to', 'for'])
const DRAFT_PHRASE_MAX = 3

// The STT decorates the HEAD of a command with punctuation — "Log dream.",
// "Music, play", "Al: …", "Message Nica — I'm late", "Music… pause" — so every
// rule reads its head words through one tokeniser that drops that decoration.
// Payloads are never touched: a dream log keeps its full stops, a message its
// commas. Only the words a rule inspects (address word, verb, target) are
// cleaned, and a free-standing dash between head and payload is a separator.
const HEAD_PUNCT = /[,.:;!?…]+$/
const DASH_TOKEN = /^[-–—]+$/
// Whisper writes a spoken "at"/"add" before a name as a handle — "add Astera"
// arrives as the single token "@Estera" (recording 2026-09-15T22-08-57.774Z).
// The "@" IS the verb: split it off as the word "at" (an `add` alias).
const AT_GLUED = /^@(.*)$/

/** Peel the first `n` head words off a normalised utterance — lowercased,
 *  trailing punctuation dropped, dash tokens skipped, a glued "@" split into
 *  its own word — with `rest` = the payload exactly as spoken (empty when
 *  nothing follows). Null when the utterance has fewer than `n` words. */
export function headWords(cased: string, n: number): { words: string[]; rest: string } | null {
  const tokens = cased.split(' ')
  const words: string[] = []
  let i = 0
  while (words.length < n && i < tokens.length) {
    let t = tokens[i]!
    if (DASH_TOKEN.test(t)) { i++; continue }
    const at = AT_GLUED.exec(t)
    if (at) {
      tokens.splice(i, 1, 'at', ...(at[1] ? [at[1]] : []))
      t = 'at'
    }
    i++
    const w = t.replace(HEAD_PUNCT, '').toLowerCase()
    if (w) words.push(w)
  }
  if (words.length < n) return null
  while (i < tokens.length && DASH_TOKEN.test(tokens[i]!)) i++
  return { words, rest: tokens.slice(i).join(' ').trim() }
}

/** Every word of a short utterance, head-cleaned — for word-SET matchers. */
function cleanWords(text: string): string[] {
  return text.split(' ').map((w) => w.replace(HEAD_PUNCT, '')).filter((w) => w && !DASH_TOKEN.test(w))
}

/** Music transport is matched as a WORD SET, not an ordered phrase — the STT
 *  gives "Music plays." as readily as "play music". Every word must be either
 *  one action word or filler, and exactly one action may appear. */
const MUSIC_ACTIONS: Record<string, 'play' | 'pause' | 'next' | 'previous'> = {
  play: 'play', plays: 'play', playing: 'play', resume: 'play', unpause: 'play', start: 'play', on: 'play',
  pause: 'pause', stop: 'pause', off: 'pause', silence: 'pause',
  next: 'next', skip: 'next', forward: 'next',
  previous: 'previous', prev: 'previous', back: 'previous', rewind: 'previous', last: 'previous',
}
const MUSIC_FILLER = new Set(['music', 'the', 'spotify', 'song', 'songs', 'track', 'tune', 'tunes', 'playback', 'this', 'that', 'some', 'please', 'go', 'it'])

/** An address word before the verb ("Music, play X" / "Spotify: next") —
 *  head-cleaned like any other head word, so the STT's punctuation is moot. */
const MUSIC_ADDRESS = new Set(['music', 'spotify'])
/** "timer cancel|stop|off|clear|reset|end" — with or without a lead-in ("the timer"). */
const TIMER_CANCEL = /^(?:(?:the|my|a)\s+)?(?:(?:countdown|timer)\s+)?(?:cancel|stop|off|clear|reset|end|kill)\b/i
/** `play <query>` — STT hears "plays" for "play" in the query form too
 *  ("Music, plays Taylor Swift"). "playing" counts only when the player was
 *  ADDRESSED ("Music, playing X"): a bare "Playing tennis later" is a note. */
const PLAY_WORD = /^plays?$/
const PLAY_WORD_ADDRESSED = /^play(?:s|ing)?$/
/** A noun spoken AFTER the verb ("play music Radiohead", "play some music,
 *  Radiohead") addresses the player, not the search — same treatment as the
 *  word-set filler. A title that genuinely starts with "Music …" (Eno's *Music
 *  for Airports*) loses its first word; the address form is far more common. */
const MUSIC_QUERY_NOUN = /^(?:(?:the|some|me)\s+)?(?:music|spotify|song|track|tune)[,.:;]?\s+/i

/** Spoken query → search string: drop a leading "some"/"me" and a spoken
 *  noun, a trailing "please", and a quoted title's wrapping quotes (only a
 *  MATCHED pair — an apostrophe inside stays). */
export function musicQuery(spoken: string): string {
  const q = spoken.trim()
    .replace(MUSIC_QUERY_NOUN, '')
    .replace(/^(?:some|me)\s+/i, '')
    .replace(/[,.]?\s+please$/i, '')
  const quoted = /^"(.+)"$/.exec(q) ?? /^'(.+)'$/.exec(q)
  return (quoted ? quoted[1]! : q).trim()
}

export function matchMusicTransport(text: string): 'play' | 'pause' | 'next' | 'previous' | null {
  const words = cleanWords(text)
  if (!words.length || words.length > 4) return null
  let action: 'play' | 'pause' | 'next' | 'previous' | null = null
  let hasNoun = false
  for (const w of words) {
    const a = MUSIC_ACTIONS[w]
    if (a) { if (action && action !== a) return null; action = a; continue }
    if (MUSIC_FILLER.has(w)) { if (w === 'music' || w === 'spotify' || w === 'song' || w === 'songs' || w === 'track' || w === 'tune' || w === 'tunes' || w === 'playback') hasNoun = true; continue }
    return null
  }
  if (!action) return null
  // Bare "on"/"off"/"back"/"last"/"start"/"forward" mean nothing without the noun.
  if (words.length === 1 && ['on', 'off', 'back', 'last', 'start', 'forward', 'go', 'it'].includes(words[0]!)) return null
  if (!hasNoun && ['on', 'off', 'back', 'last', 'forward'].some((w) => words.includes(w))) return null
  return action
}

type VerbName = keyof RingSchema['verbs']

/** Resolve the first spoken word to a schema verb (name, alias, or one edit).
 *  `exact` = name/alias hit; a fuzzy hit is a weaker claim (see routeByRules). */
export function matchVerb(word: string, schema: RingSchema): { verb: VerbName; exact: boolean } | null {
  const names = Object.keys(schema.verbs) as VerbName[]
  for (const v of names) if (word === v || schema.verbs[v].aliases.includes(word)) return { verb: v, exact: true }
  const fuzzy = names.filter((v) => fuzzyEqual(word, v) || schema.verbs[v].aliases.some((a) => fuzzyEqual(word, a)))
  return fuzzy.length === 1 ? { verb: fuzzy[0]!, exact: false } : null
}

/** Deterministic pass. Returns null when no rule fires — the caller decides
 *  whether to consult the LLM and/or the fallback agent. */
export function routeByRules(rawText: string, schema: RingSchema, env: RouteEnv): RouteMatch | null {
  const cased = normaliseKeepCase(rawText)
  const text = cased.toLowerCase()
  if (!text) return null
  const v = schema.verbs

  // "<word> <rest>" and "<verb> <target> <payload>", heads cleaned.
  const one = headWords(cased, 1)
  const two = headWords(cased, 2)

  // Music: whole-utterance transport words, before the verb tree so a bare
  // "play"/"skip" never gets read as a verb with a missing target.
  if (v.music.enabled) {
    const transport = matchMusicTransport(text)
    if (transport) return { rule: `music.${transport}`, command: { kind: 'music', action: transport } }
    // play <query> — optionally addressed ("Music, play X").
    const playQuery = (q: string): RouteMatch => ({ rule: 'music.play-query', command: { kind: 'music', action: 'play', query: musicQuery(q) } })
    if (one && MUSIC_ADDRESS.has(one.words[0]!)) {
      if (two && PLAY_WORD_ADDRESSED.test(two.words[1]!) && two.rest) return playQuery(two.rest)
    } else if (one && PLAY_WORD.test(one.words[0]!) && one.rest) {
      return playQuery(one.rest)
    }
  }

  // "al <text>" — addressed to AL by name: straight to his ring fork, no tree,
  // no classifier (that exists to rescue mis-heard TREE commands).
  const alForms = new Set(['al', ...(v.message.contacts[AL_CONTACT] ?? [])])
  if (one?.rest && alForms.has(one.words[0]!)) {
    return { rule: 'al.direct', command: { kind: 'fallback', agentKey: AL_CONTACT, text: one.rest } }
  }

  // echo <text> — no target; the whole remainder is the payload.
  if (one?.rest && matchVerb(one.words[0]!, schema)?.verb === 'echo') {
    return { rule: 'echo', command: { kind: 'echo', text: one.rest } }
  }

  // timer <duration> | timer cancel — the glasses' native countdown (0x07).
  // No target word: the remainder IS the duration ("timer 10 minutes", "set a
  // timer for ten minutes", "countdown 1:30"). A remainder that is not a
  // duration is NOT an error — "set the mood" must fall through to the LLM.
  if (v.timer.enabled && one?.rest && matchVerb(one.words[0]!, schema)?.verb === 'timer') {
    if (TIMER_CANCEL.test(one.rest)) return { rule: 'timer.cancel', command: { kind: 'timer', seconds: null, spoken: one.rest } }
    const seconds = parseDuration(one.rest)
    if (seconds !== null) return { rule: 'timer.start', command: { kind: 'timer', seconds, spoken: one.rest } }
  }

  // remind [me] [in <duration> | at <time> | tomorrow …] <text> — no target
  // word: the remainder is the text, with a time phrase peeled off either end.
  // A FUZZY verb hit ("rewind" ≈ "remind") needs "me" or a time phrase to
  // count — free text alone would make every near-miss a reminder.
  if (one?.rest) {
    const m = matchVerb(one.words[0]!, schema)
    if (m?.verb === 'remind') {
      const parsed = parseReminder(one.rest, v.remind.defaultIn, !m.exact)
      if (parsed) return { rule: parsed.spoken ? 'remind.at' : 'remind.default', command: { kind: 'remind', ...parsed } }
    }
  }

  const parts = two?.rest ? { verb: two.words[0]!, target: two.words[1]!, payload: two.rest } : null
  const matched = parts ? matchVerb(parts.verb, schema) : null

  if (matched && parts) {
    const { target, payload } = parts
    const projects = projectForms(schema.projects, env.projects)
    // A verb matched only FUZZILY ("look" ≈ alias "lock") with a target
    // nothing recognises is almost certainly not a command at all — let it
    // fall through to the LLM/fallback instead of dying as unknown-target.
    // An EXACT verb with a bad target is a real mis-heard target → push.
    const unknown = (verb: string): RouteMatch | null =>
      matched.exact ? { rule: `${verb}.unknown-target`, command: { kind: 'unknown-target', verb, target, text } } : null
    switch (matched.verb) {
      case 'add': {
        const list = resolveSpoken(target, spokenForms(v.add.targets))
        if (list) {
          const t = v.add.targets[list]!
          return { rule: t.dated ? 'add.log' : 'add.list', command: { kind: 'list', target: list, file: t.file, item: payload, dated: t.dated, ...(t.enrich ? { enrich: t.enrich } : {}) } }
        }
        const card = projectCard(target, payload, projects, v.add.projectColumn)
        if (card) return { rule: 'add.card', command: card }
        // Trailing-target phrasing, tried only now: "add Count of Monte Cristo
        // to movie list" puts the target at the END, so the second word is the
        // start of the ITEM. First-word target wins, so "add movies Journey to
        // the Center of the Earth" keeps its full title.
        for (const { item, spoken } of splitTrailingTarget(one?.rest ?? '')) {
          const t2 = resolveSpoken(spoken, spokenForms(v.add.targets))
          if (t2) {
            const t = v.add.targets[t2]!
            return { rule: t.dated ? 'add.log' : 'add.list', command: { kind: 'list', target: t2, file: t.file, item, dated: t.dated, ...(t.enrich ? { enrich: t.enrich } : {}) } }
          }
          const project = resolveSpoken(spoken, projects) ?? resolveSpoken(spoken.replace(/\s+/g, '-'), projects)
          if (project) return { rule: 'add.card', command: { kind: 'card', project, column: v.add.projectColumn, text: item } }
        }
        // "Look, these are three dreams. I had a dream…" — the target is in
        // the opening SENTENCE rather than the head slot; the sentence is
        // command wording, the payload starts after it. Runs for a fuzzy
        // verb too (look ≈ lock), which is how that transcript gets here.
        const scanned = scanFirstSentence(one?.rest ?? '', spokenForms(v.add.targets))
        if (scanned) {
          const t = v.add.targets[scanned.target]!
          return { rule: t.dated ? 'add.log-sentence' : 'add.list-sentence', weak: true, command: { kind: 'list', target: scanned.target, file: t.file, item: scanned.payload, dated: t.dated, ...(t.enrich ? { enrich: t.enrich } : {}) } }
        }
        return unknown('add')
      }
      case 'start': {
        const card = projectCard(target, payload, projects, v.start.column)
        if (card) return { rule: 'start.card', command: card }
        return unknown('start')
      }
      case 'message': {
        const hit = resolveRecipientAt(cased, 1, schema, env)
        if (hit) return hit.rest ? { rule: 'message', command: { kind: 'message', contact: hit.contact, spoken: hit.spoken, text: hit.rest.replace(MESSAGE_LEAD, '') } } : null
        return unknown('message')
      }
      case 'voice': {
        const r = resolveRecipientBehindPhrase(cased, schema, env, VOICE_PHRASE, VOICE_PHRASE_MAX)
        if (r.kind === 'hit') return r.rest ? { rule: 'voice', command: { kind: 'voice', contact: r.contact, spoken: r.spoken, text: r.rest } } : null
        if (r.kind === 'none') return unknown('voice')
        return matched.exact ? { rule: 'voice.unknown-target', command: { kind: 'unknown-target', verb: 'voice', target: r.spoken, text } } : null
      }
      case 'draft': {
        const r = resolveRecipientBehindPhrase(cased, schema, env, DRAFT_PHRASE, DRAFT_PHRASE_MAX)
        if (r.kind === 'hit') return r.rest ? { rule: 'draft', command: { kind: 'draft', contact: r.contact, spoken: r.spoken, text: r.rest.replace(MESSAGE_LEAD, '') } } : null
        if (r.kind === 'none') return unknown('draft')
        return matched.exact ? { rule: 'draft.unknown-target', command: { kind: 'unknown-target', verb: 'draft', target: r.spoken, text } } : null
      }
      case 'echo':
      case 'music':
      case 'timer':
      case 'remind':
        break
    }
  }

  return null
}

/** The recipient named at head word `p`: the LONGEST run of words (up to the
 *  longest form in the note — "control room" is two) that is a contact or room
 *  form, then derived first names, then a fuzzy hit on a single word against
 *  the workspace's usernames. A recipient with nothing after it comes back
 *  with an empty `rest` — no command, and never a shorter match with the
 *  name's tail as the payload ("message control room" must not send "room"). */
function resolveRecipientAt(cased: string, p: number, schema: RingSchema, env: RouteEnv): { contact: string; spoken: string; rest: string } | null {
  const forms = recipientForms(schema.verbs.message, env.contacts)
  const longest = Math.max(1, ...[...forms.keys()].map((f) => f.split(' ').length))
  for (let k = longest; k >= 1; k--) {
    const head = headWords(cased, p + k)
    if (!head) continue
    const spoken = head.words.slice(p).join(' ')
    const contact = resolveSpoken(spoken, forms) ?? (k === 1 ? pickFuzzy(spoken, env.contacts) : null)
    if (contact) return { contact, spoken, rest: head.rest }
  }
  return null
}

/** The recipient after the verb, possibly behind verb-phrase words ("voice
 *  NOTE mum", "draft A MESSAGE TO mum") — skipped one at a time, at most
 *  `max`. `hit` = a recipient (rest may be empty: no command); `stranger` =
 *  the first word that is neither a phrase word nor a recipient; `none` =
 *  the utterance ran out. */
function resolveRecipientBehindPhrase(cased: string, schema: RingSchema, env: RouteEnv, phrase: Set<string>, max: number):
  | { kind: 'hit'; contact: string; spoken: string; rest: string }
  | { kind: 'stranger'; spoken: string }
  | { kind: 'none' } {
  for (let p = 1, skipped = 0; ; p++, skipped++) {
    const hit = resolveRecipientAt(cased, p, schema, env)
    if (hit) return { kind: 'hit', ...hit }
    const head = headWords(cased, p + 1)
    if (!head?.rest) return { kind: 'none' }
    const spoken = head.words[p]!
    if (skipped >= max || !phrase.has(spoken)) return { kind: 'stranger', spoken }
  }
}

const SENTENCE_END = /[.!?]$/

/** A known target word anywhere in the FIRST sentence after the verb, when
 *  that sentence ends within `maxWords` and something follows it. Exact
 *  spoken forms only — a fuzzy hit ten words in is a guess, not a rescue.
 *  Payload = everything after the sentence. */
export function scanFirstSentence(rest: string, forms: Map<string, string>, maxWords = 10): { target: string; payload: string } | null {
  const tokens = rest.split(' ').filter(Boolean)
  const end = tokens.findIndex((t, i) => i < maxWords && SENTENCE_END.test(t))
  if (end < 0 || end === tokens.length - 1) return null
  for (let i = 0; i <= end; i++) {
    const target = forms.get(tokens[i]!.replace(HEAD_PUNCT, '').toLowerCase())
    if (target) return { target, payload: tokens.slice(end + 1).join(' ') }
  }
  return null
}

const TRAILING_ARTICLE = /^(?:the|my|your|a)$/i

/** Every "<item> to [the|my] <target> [list]" reading of a payload, left to
 *  right — natural speech puts the target last ("Count of Monte Cristo to
 *  movie list"). The caller resolves each `spoken` and takes the first hit, so
 *  a payload with several "to"s ("note to self to movie list") still lands. */
export function splitTrailingTarget(payload: string): Array<{ item: string; spoken: string }> {
  const words = payload.split(' ').filter(Boolean)
  const out: Array<{ item: string; spoken: string }> = []
  for (let i = 1; i < words.length - 1; i++) {
    if (words[i]!.replace(HEAD_PUNCT, '').toLowerCase() !== 'to') continue
    let tail = words.slice(i + 1)
    if (tail.length > 1 && TRAILING_ARTICLE.test(tail[0]!.replace(HEAD_PUNCT, ''))) tail = tail.slice(1)
    if (tail.length > 1 && tail.at(-1)!.replace(HEAD_PUNCT, '').toLowerCase() === 'list') tail = tail.slice(0, -1)
    const item = words.slice(0, i).join(' ').trim()
    const spoken = tail.join(' ').replace(HEAD_PUNCT, '').trim().toLowerCase()
    if (item && spoken) out.push({ item, spoken })
  }
  return out
}

/** `<target> <payload>` against the project slugs — slugs may be hyphenated
 *  two-word names ("reflection tools"), so the payload's first word is tried
 *  as the second half. */
function projectCard(target: string, payload: string, projects: Map<string, string>, column: string): RingCommand | null {
  const second = headWords(payload, 1)
  const twoWord = second?.rest ? resolveSpoken(`${target}-${second.words[0]!}`, projects) : null
  const project = resolveSpoken(target, projects) ?? twoWord
  if (!project) return null
  return { kind: 'card', project, column, text: project === twoWord ? second!.rest : payload }
}

/** Human-readable one-liner for pushes / logs. */
export function describeCommand(c: RingCommand): string {
  switch (c.kind) {
    case 'list': return `${c.dated ? 'log' : 'add'} ${c.target}: ${c.item}`
    case 'echo': return `echo: ${c.text}`
    case 'card': return `card → ${c.project} (${c.column}): ${c.text}`
    case 'message': return `message ${c.spoken} (${c.contact}): ${c.text}`
    case 'voice': return `voice note → ${c.spoken} (${c.contact}): ${c.text}`
    case 'draft': return `draft → ${c.spoken} (${c.contact}): ${c.text}`
    case 'fallback': return `→ @${c.agentKey} (fallback): ${c.text}`
    case 'music': return `music ${c.action}${c.query ? ` "${c.query}"` : ''}`
    case 'timer': return c.seconds === null ? 'timer cancel' : `timer ${formatDuration(c.seconds)} (${c.spoken})`
    case 'remind': return `remind ${describeWhen(c.when)}${c.spoken ? ` ("${c.spoken}")` : ''}: ${c.text}`
    case 'unknown-target': return `${c.verb}: no target called "${c.target}"`
    case 'unknown': return `unrecognised: ${c.text}`
  }
}
