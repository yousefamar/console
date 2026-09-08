// Parent → fresh-context fork handover digest (pure, no I/O).
//
// A fresh ticket-fork (the default since ^tall-colt) is a NEW session at the
// parent's cwd: CLAUDE.md and auto-memory reach it natively, the card rides
// the envelope — the only thing it lacks is the parent's recent CONVERSATION.
// This is a template over the parent's hub message log, not a model call:
// deterministic, zero latency in the dispatch path, and bounded by
// `maxChars` (default ≈2k tokens). Machine traffic is filtered out: envelopes,
// merge hand-backs, cron wakes and nudges all start with `[…]`, and a Console
// parent's log is mostly those.

import type { LoggableHubMessage } from '../protocol.js'

export interface DigestExchange {
  /** Yousef's message (machine envelopes excluded). */
  prompt: string
  /** The first assistant text that followed it, if any. */
  reply: string | null
}

export interface ParentDigestOpts {
  /** Hard cap on the rendered digest, in characters. */
  maxChars?: number
  /** How many human exchanges to consider, newest first. */
  maxExchanges?: number
  /** Per-message clamp before rendering. */
  promptChars?: number
  replyChars?: number
  /** Parent's identity line, rendered first when given. */
  parent?: { name?: string | null; agentKey?: string | null; cwd?: string | null }
  /** The parent's open plan items, if it has any (SessionInfo.todos). */
  todos?: Array<{ subject: string; status: string }> | null
}

const DEFAULTS = { maxChars: 8000, maxExchanges: 8, promptChars: 600, replyChars: 400 }

/** Hub-injected prompts (board envelopes, merges, cron wakes, nudges) all open
 *  with a bracketed tag — never part of "what we discussed". */
export function isMachinePrompt(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('[') || t.startsWith('/') || t === ''
}

/** Walk the log and pair each human prompt with the first assistant `text`
 *  that follows it (before the next prompt). Newest exchanges LAST. */
export function extractExchanges(log: readonly LoggableHubMessage[], opts: ParentDigestOpts = {}): DigestExchange[] {
  const { maxExchanges, promptChars, replyChars } = { ...DEFAULTS, ...opts }
  const out: DigestExchange[] = []
  let current: DigestExchange | null = null
  for (const m of log) {
    if (m.type === 'user_prompt') {
      if (current) out.push(current)
      current = isMachinePrompt(m.content) ? null : { prompt: clamp(m.content, promptChars), reply: null }
    } else if (m.type === 'text' && current && current.reply === null && m.content.trim()) {
      current.reply = clamp(m.content, replyChars)
    }
  }
  if (current) out.push(current)
  return out.slice(-maxExchanges)
}

/** Render the digest, or null when there is nothing worth carrying. */
export function buildParentDigest(log: readonly LoggableHubMessage[], opts: ParentDigestOpts = {}): string | null {
  const { maxChars } = { ...DEFAULTS, ...opts }
  const lines: string[] = []
  if (opts.parent?.name || opts.parent?.agentKey) {
    const who = [opts.parent.name, opts.parent.agentKey ? `@${opts.parent.agentKey}` : null].filter(Boolean).join(' ')
    lines.push(`Parent: ${who}${opts.parent.cwd ? ` — cwd ${opts.parent.cwd}` : ''}. You run from the same cwd, so its CLAUDE.md and auto-memory are yours.`)
  }
  const open = (opts.todos ?? []).filter((t) => t.status !== 'completed')
  if (open.length) {
    lines.push(`Parent's open plan items: ${open.map((t) => t.subject).join(' · ')}`)
  }
  const exchanges = extractExchanges(log, opts)
  if (exchanges.length) {
    lines.push('Recent conversation with Yousef (oldest first):')
    for (const x of exchanges) {
      lines.push(`- Yousef: ${oneLine(x.prompt)}`)
      if (x.reply) lines.push(`  ↳ parent: ${oneLine(x.reply)}`)
    }
  }
  if (!lines.length) return null
  // Trim from the OLDEST exchange until it fits; the identity/plan lines stay.
  let text = lines.join('\n')
  while (text.length > maxChars && exchanges.length) {
    exchanges.shift()
    const head = lines.filter((l) => !l.startsWith('- Yousef: ') && !l.startsWith('  ↳ parent: '))
    const body = exchanges.flatMap((x) => [`- Yousef: ${oneLine(x.prompt)}`, ...(x.reply ? [`  ↳ parent: ${oneLine(x.reply)}`] : [])])
    text = [...head, ...body].join('\n')
    if (!exchanges.length) text = head.filter((l) => l !== 'Recent conversation with Yousef (oldest first):').join('\n')
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

function clamp(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ')
}
