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

import type { RingSchema, ListTarget } from './schema.js'

export interface RingAgent {
  id: string
  name: string
  agentKey: string | null
}

/** What the router can see besides the transcript — all resolved by the hub. */
export interface RouteEnv {
  /** Vault project slugs (an `add` target naming one files a board card). */
  projects: string[]
  /** AL workspace usernames (users/<name>.md) for `message`. */
  contacts: string[]
}

export type RingCommand =
  | { kind: 'log'; target: string; file: string; text: string }
  | { kind: 'list'; target: string; file: string; item: string; enrich?: ListTarget['enrich'] }
  | { kind: 'card'; project: string; column: string; text: string }
  | { kind: 'message'; contact: string; spoken: string; text: string }
  /** Only ever minted by the FALLBACK (unclaimed text → AL) — there is no
   *  spoken "agent" verb: Yousef talks to projects (`add <project> …` forks a
   *  card), not to agents. */
  | { kind: 'agent'; targetId: string; targetName: string; message: string }
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

/** Levenshtein distance, capped early at `max + 1`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]!
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

const MESSAGE_LEAD = /^(?:to|that)\s+/i
const MUSIC_TAIL = '(?:\\s+(?:the\\s+)?(?:music|spotify|song|track|tunes?|playback|this))?'
const MUSIC_RULES: Array<{ rule: string; re: RegExp; action: 'play' | 'pause' | 'next' | 'previous' }> = [
  { rule: 'music.play', re: new RegExp(`^(?:play|resume|unpause|start)${MUSIC_TAIL}$`), action: 'play' },
  { rule: 'music.pause', re: new RegExp(`^(?:pause|stop)${MUSIC_TAIL}$`), action: 'pause' },
  { rule: 'music.next', re: new RegExp(`^(?:next|skip)${MUSIC_TAIL}$`), action: 'next' },
  { rule: 'music.previous', re: new RegExp(`^(?:previous|prev|last|back|go back)${MUSIC_TAIL}$`), action: 'previous' },
]

type VerbName = keyof RingSchema['verbs']

/** Resolve the first spoken word to a schema verb (name, alias, or one edit). */
export function matchVerb(word: string, schema: RingSchema): VerbName | null {
  const names = Object.keys(schema.verbs) as VerbName[]
  for (const v of names) if (word === v || schema.verbs[v].aliases.includes(word)) return v
  const fuzzy = names.filter((v) => fuzzyEqual(word, v) || schema.verbs[v].aliases.some((a) => fuzzyEqual(word, a)))
  return fuzzy.length === 1 ? fuzzy[0]! : null
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
    for (const m of MUSIC_RULES) if (m.re.test(text)) return { rule: m.rule, command: { kind: 'music', action: m.action } }
    const play = /^(?:play|(?:music|spotify)\s+play)\s+(.+)$/i.exec(cased)
    if (play) return { rule: 'music.play-query', command: { kind: 'music', action: 'play', query: play[1]!.replace(/^(?:some|me)\s+/i, '') } }
  }

  const parts = split3(cased)
  const verb = parts ? matchVerb(parts.verb, schema) : null

  if (verb && parts) {
    const { target, payload } = parts
    switch (verb) {
      case 'log': {
        const known = pickFuzzy(target, Object.keys(v.log.targets))
        if (known) return { rule: 'log', command: { kind: 'log', target: known, file: v.log.targets[known]!, text: payload } }
        if (v.log.createUnknown && /^[a-z][a-z0-9-]{1,30}$/.test(target)) {
          return { rule: 'log.create', command: { kind: 'log', target, file: `scratch/logs/${target}.md`, text: payload } }
        }
        return { rule: 'log.unknown-target', command: { kind: 'unknown-target', verb: 'log', target, text } }
      }
      case 'add': {
        const list = pickFuzzy(target, Object.keys(v.add.targets))
        if (list) {
          const t = v.add.targets[list]!
          return { rule: 'add.list', command: { kind: 'list', target: list, file: t.file, item: payload, ...(t.enrich ? { enrich: t.enrich } : {}) } }
        }
        // Project slugs may be hyphenated two-word names ("reflection tools").
        const [p2, ...restWords] = payload.split(' ')
        const twoWord = p2 && restWords.length ? pickFuzzy(`${target}-${p2.toLowerCase()}`, env.projects) : null
        const project = pickFuzzy(target, env.projects) ?? twoWord
        if (project) {
          const text = project === twoWord ? restWords.join(' ') : payload
          return { rule: 'add.card', command: { kind: 'card', project, column: v.add.projectColumn, text } }
        }
        return { rule: 'add.unknown-target', command: { kind: 'unknown-target', verb: 'add', target, text } }
      }
      case 'message': {
        const nick = pickFuzzy(target, Object.keys(v.message.contacts))
        const contact = nick ? v.message.contacts[nick]! : pickFuzzy(target, env.contacts)
        if (contact) return { rule: nick ? 'message.nickname' : 'message.contact', command: { kind: 'message', contact, spoken: target, text: payload.replace(MESSAGE_LEAD, '') } }
        return { rule: 'message.unknown-target', command: { kind: 'unknown-target', verb: 'message', target, text } }
      }
      case 'music':
        break
    }
  }

  return null
}

/** Human-readable one-liner for pushes / logs. */
export function describeCommand(c: RingCommand): string {
  switch (c.kind) {
    case 'log': return `log ${c.target}: ${c.text}`
    case 'list': return `add ${c.target}: ${c.item}`
    case 'card': return `card → ${c.project} (${c.column}): ${c.text}`
    case 'message': return `message ${c.spoken} (${c.contact}): ${c.text}`
    case 'agent': return `→ ${c.targetName}: ${c.message}`
    case 'music': return `music ${c.action}${c.query ? ` "${c.query}"` : ''}`
    case 'unknown-target': return `${c.verb}: no target called "${c.target}"`
    case 'unknown': return `unrecognised: ${c.text}`
  }
}
