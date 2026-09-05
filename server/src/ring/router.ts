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

import { spokenForms, contactForms, AL_CONTACT, type RingSchema, type ListTarget } from './schema.js'

/** What the router can see besides the transcript — all resolved by the hub. */
export interface RouteEnv {
  /** Vault project slugs (an `add` target naming one files a board card). */
  projects: string[]
  /** AL workspace usernames (users/<name>.md) for `message`. */
  contacts: string[]
}

export type RingCommand =
  /** Append to a list/log note. `dated` = log semantics (day heading + HH:MM). */
  | { kind: 'list'; target: string; file: string; item: string; dated: boolean; enrich?: ListTarget['enrich'] }
  | { kind: 'echo'; text: string }
  | { kind: 'card'; project: string; column: string; text: string }
  | { kind: 'message'; contact: string; spoken: string; text: string }
  /** Only ever minted by the FALLBACK (unclaimed text → the fallback agent) —
   *  there is no spoken "agent" verb: Yousef talks to projects (`add <project>
   *  …` forks a card), not to agents. */
  | { kind: 'fallback'; agentKey: string; text: string }
  | { kind: 'music'; action: 'play' | 'pause' | 'next' | 'previous'; query?: string }
  /** A verb matched but its target didn't — actionable feedback, not a fallback. */
  | { kind: 'unknown-target'; verb: string; target: string; text: string }
  | { kind: 'unknown'; text: string }

export interface RouteMatch {
  command: RingCommand
  /** Which rule fired — surfaces in the recording metadata for schema tuning. */
  rule: string
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

/** "Music, …" / "Spotify: …" / "Music - …" / "Music… …" — the STT punctuates
 *  an address word every which way. */
const MUSIC_VOCATIVE = /^(?:music|spotify)(?:[,.:;!…]+|\s+[-–—])?\s+/i
/** `play <query>` — STT hears "plays" for "play" in the query form too
 *  ("Music, plays Taylor Swift"). "playing" counts only when the player was
 *  ADDRESSED ("Music, playing X"): a bare "Playing tennis later" is a note. */
const MUSIC_PLAY_QUERY = /^plays?\s+(.+)$/i
const MUSIC_PLAY_QUERY_ADDRESSED = /^play(?:s|ing)?\s+(.+)$/i
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
  const words = text.split(' ').filter(Boolean)
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

/** Split "verb target payload" — verb/target lowercased with trailing
 *  punctuation dropped (the STT likes "Log dream. I was…"), payload as spoken. */
function split3(cased: string): { verb: string; target: string; payload: string } | null {
  const m = /^(\S+?)[,.:]?\s+(\S+?)[,.:]?\s+(.+)$/.exec(cased)
  if (!m) return null
  return { verb: m[1]!.toLowerCase(), target: m[2]!.toLowerCase(), payload: m[3]!.trim() }
}

/** Deterministic pass. Returns null when no rule fires — the caller decides
 *  whether to consult the LLM and/or the fallback agent. */
export function routeByRules(rawText: string, schema: RingSchema, env: RouteEnv): RouteMatch | null {
  const cased = normaliseKeepCase(rawText)
  const text = cased.toLowerCase()
  if (!text) return null
  const v = schema.verbs

  // Music: whole-utterance transport words, before the verb tree so a bare
  // "play"/"skip" never gets read as a verb with a missing target.
  if (v.music.enabled) {
    // "Music, play …" — the STT punctuates an address word; strip the vocative
    // (with its comma) before either matcher sees it.
    const unaddressed = cased.replace(MUSIC_VOCATIVE, '')
    const transport = matchMusicTransport(text) ?? matchMusicTransport(unaddressed.toLowerCase())
    if (transport) return { rule: `music.${transport}`, command: { kind: 'music', action: transport } }
    const play = (unaddressed === cased ? MUSIC_PLAY_QUERY : MUSIC_PLAY_QUERY_ADDRESSED).exec(unaddressed)
    if (play) return { rule: 'music.play-query', command: { kind: 'music', action: 'play', query: musicQuery(play[1]!) } }
  }

  const first = /^(\S+?)[,.:]?\s+(.+)$/.exec(cased)

  // "al <text>" — addressed to AL by name: straight to his ring fork, no tree,
  // no classifier (that exists to rescue mis-heard TREE commands).
  const alForms = new Set(['al', ...(v.message.contacts[AL_CONTACT] ?? [])])
  if (first && alForms.has(first[1]!.toLowerCase())) {
    return { rule: 'al.direct', command: { kind: 'fallback', agentKey: AL_CONTACT, text: first[2]!.trim() } }
  }

  // echo <text> — no target; the whole remainder is the payload.
  if (first && matchVerb(first[1]!.toLowerCase(), schema)?.verb === 'echo') {
    return { rule: 'echo', command: { kind: 'echo', text: first[2]!.trim() } }
  }

  const parts = split3(cased)
  const matched = parts ? matchVerb(parts.verb, schema) : null

  if (matched && parts) {
    const { target, payload } = parts
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
        const card = projectCard(target, payload, env.projects, v.add.projectColumn)
        if (card) return { rule: 'add.card', command: card }
        return unknown('add')
      }
      case 'start': {
        const card = projectCard(target, payload, env.projects, v.start.column)
        if (card) return { rule: 'start.card', command: card }
        return unknown('start')
      }
      case 'message': {
        const contact = resolveSpoken(target, contactForms(v.message.contacts, env.contacts)) ?? pickFuzzy(target, env.contacts)
        // "message al …" is Yousef talking TO AL, not sending as himself to
        // AL's WhatsApp — same destination as the bare "al <text>" verb.
        if (contact === AL_CONTACT) return { rule: 'al.direct', command: { kind: 'fallback', agentKey: AL_CONTACT, text: payload.replace(MESSAGE_LEAD, '') } }
        if (contact) return { rule: 'message', command: { kind: 'message', contact, spoken: target, text: payload.replace(MESSAGE_LEAD, '') } }
        return unknown('message')
      }
      case 'echo':
      case 'music':
        break
    }
  }

  return null
}

/** `<target> <payload>` against the project slugs — slugs may be hyphenated
 *  two-word names ("reflection tools"), so the payload's first word is tried
 *  as the second half. */
function projectCard(target: string, payload: string, projects: string[], column: string): RingCommand | null {
  const [p2, ...restWords] = payload.split(' ')
  const twoWord = p2 && restWords.length ? pickFuzzy(`${target}-${p2.toLowerCase()}`, projects) : null
  const project = pickFuzzy(target, projects) ?? twoWord
  if (!project) return null
  return { kind: 'card', project, column, text: project === twoWord ? restWords.join(' ') : payload }
}

/** Human-readable one-liner for pushes / logs. */
export function describeCommand(c: RingCommand): string {
  switch (c.kind) {
    case 'list': return `${c.dated ? 'log' : 'add'} ${c.target}: ${c.item}`
    case 'echo': return `echo: ${c.text}`
    case 'card': return `card → ${c.project} (${c.column}): ${c.text}`
    case 'message': return `message ${c.spoken} (${c.contact}): ${c.text}`
    case 'fallback': return `→ @${c.agentKey} (fallback): ${c.text}`
    case 'music': return `music ${c.action}${c.query ? ` "${c.query}"` : ''}`
    case 'unknown-target': return `${c.verb}: no target called "${c.target}"`
    case 'unknown': return `unrecognised: ${c.text}`
  }
}
