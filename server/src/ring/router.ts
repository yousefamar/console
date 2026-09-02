// Ring command router — PURE string parsing, no LLM. A transcript from the
// Pebble Index 01 becomes a RingCommand via an ordered rule table; the LLM
// (see llm-fallback.ts) is consulted only when nothing here matches, as a
// hedge against mis-transcription. Keep every rule deterministic and
// testable — the schema is meant to be read and extended by hand.

export interface RingAgent {
  id: string
  name: string
  agentKey: string | null
  /** Forks are never first-word candidates ("astera" → the root, not a fork). */
  fork?: boolean
}

export type RingCommand =
  | { kind: 'agent'; targetId: string; targetName: string; message: string }
  | { kind: 'music'; action: 'play' | 'pause' | 'next' | 'previous'; query?: string }
  | { kind: 'unknown'; text: string }

export interface RouteMatch {
  command: RingCommand
  /** Which rule fired — surfaces in the recording metadata for schema tuning. */
  rule: string
}

/** Mis-transcription aliases for names the STT reliably mangles. Keyed by
 *  agentKey; values are additional lowercase tokens that mean that agent. */
export const AGENT_ALIASES: Record<string, string[]> = {
  al: ['al', 'owl', 'el', 'hal', 'alan', 'ale', 'a l', 'l'],
}

const FILLERS = /^(?:hey|hi|ok|okay|um|uh|so|please|right|yeah)[,.]?\s+/i

export function normalise(text: string): string {
  let t = text.normalize('NFKC').toLowerCase()
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

interface NameToken { token: string; agent: RingAgent; weight: number }

/** Every spoken form that could mean an agent, longest first so "console
 *  general" beats "console". Weight breaks length ties: full name > key >
 *  alias > unique first word. */
export function agentTokens(agents: RingAgent[]): NameToken[] {
  const out: NameToken[] = []
  const firstWords = new Map<string, RingAgent[]>()
  for (const a of agents) {
    const name = normalise(a.name.replace(/\s*\(fork\)\s*$/i, ''))
    if (name) out.push({ token: name, agent: a, weight: 3 })
    if (a.agentKey) {
      const key = a.agentKey.toLowerCase().replace(/-/g, ' ')
      if (key !== name) out.push({ token: key, agent: a, weight: 2 })
      for (const alias of AGENT_ALIASES[a.agentKey.toLowerCase()] ?? []) {
        if (alias !== name && alias !== key) out.push({ token: alias, agent: a, weight: 1 })
      }
    }
    if (!a.fork) {
      const fw = name.split(' ')[0]
      if (fw && fw !== name) firstWords.set(fw, [...(firstWords.get(fw) ?? []), a])
    }
  }
  for (const [fw, owners] of firstWords) {
    if (owners.length === 1) out.push({ token: fw, agent: owners[0]!, weight: 0 })
  }
  return out.sort((x, y) => y.token.length - x.token.length || y.weight - x.weight)
}

/** If `text` starts with an agent token, return the agent + the remainder. */
export function matchAgentPrefix(text: string, tokens: NameToken[]): { agent: RingAgent; rest: string } | null {
  for (const { token, agent } of tokens) {
    if (text === token) return { agent, rest: '' }
    if (text.startsWith(token)) {
      const ch = text[token.length]!
      if (ch === ' ' || ch === ',' || ch === ':' || ch === '.') {
        return { agent, rest: text.slice(token.length).replace(/^[,:.]?\s*/, '') }
      }
    }
  }
  return null
}

const ADDRESS_VERB = /^(?:tell|ask|message|msg|ping|text|say to|send to|forward to|to|for)\s+(.+)$/
const MESSAGE_LEAD = /^(?:to|that)\s+/

const MUSIC_TAIL = '(?:\\s+(?:the\\s+)?(?:music|spotify|song|track|tunes?|playback|this))?'
const MUSIC_RULES: Array<{ rule: string; re: RegExp; action: 'play' | 'pause' | 'next' | 'previous' }> = [
  { rule: 'music.play', re: new RegExp(`^(?:play|resume|unpause|start)${MUSIC_TAIL}$`), action: 'play' },
  { rule: 'music.pause', re: new RegExp(`^(?:pause|stop)${MUSIC_TAIL}$`), action: 'pause' },
  { rule: 'music.next', re: new RegExp(`^(?:next|skip)${MUSIC_TAIL}$`), action: 'next' },
  { rule: 'music.previous', re: new RegExp(`^(?:previous|prev|last|back|go back)${MUSIC_TAIL}$`), action: 'previous' },
]

/** Deterministic pass. Returns null when no rule fires — the caller decides
 *  whether to consult the LLM and/or a fallback agent. */
export function routeByRules(rawText: string, agents: RingAgent[]): RouteMatch | null {
  const text = normalise(rawText)
  if (!text) return null
  const tokens = agentTokens(agents)

  // "tell <agent> <message>" / "ask <agent> <question>"
  const verb = ADDRESS_VERB.exec(text)
  if (verb) {
    const hit = matchAgentPrefix(verb[1]!, tokens)
    if (hit) {
      const message = hit.rest.replace(MESSAGE_LEAD, '').trim()
      if (message) return { rule: 'agent.verb', command: { kind: 'agent', targetId: hit.agent.id, targetName: hit.agent.name, message } }
    }
  }

  // "<agent>, <message>" — name-first addressing.
  const direct = matchAgentPrefix(text, tokens)
  if (direct && direct.rest) {
    const message = direct.rest.replace(MESSAGE_LEAD, '').trim()
    if (message) return { rule: 'agent.direct', command: { kind: 'agent', targetId: direct.agent.id, targetName: direct.agent.name, message } }
  }

  for (const m of MUSIC_RULES) {
    if (m.re.test(text)) return { rule: m.rule, command: { kind: 'music', action: m.action } }
  }
  const playQuery = /^play\s+(.+)$/.exec(text)
  if (playQuery) return { rule: 'music.play-query', command: { kind: 'music', action: 'play', query: playQuery[1]!.replace(/^(?:some|me)\s+/, '') } }

  return null
}

/** Human-readable one-liner for pushes / logs. */
export function describeCommand(c: RingCommand): string {
  switch (c.kind) {
    case 'agent': return `→ ${c.targetName}: ${c.message}`
    case 'music': return `music ${c.action}${c.query ? ` "${c.query}"` : ''}`
    case 'unknown': return `unrecognised: ${c.text}`
  }
}
