// Fork-cost ledger: what a ticket-fork cost per turn, by context mode.
//
// ^tall-colt made fresh-context forks the default and kept `#inherit` as the
// opt-in — this is the measurement that decides whether that was right. Every
// fork that ENDS (merged, killed, self-destructed) appends one line to a JSONL
// file; `aggregate()` folds those with the still-live forks into per-mode
// totals. cache_read per turn is the headline: an inherited fork re-reads the
// parent's whole transcript on every message, a fresh one only its own.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TokenUsage } from '../protocol.js'

export type ForkContext = 'fresh' | 'inherited' | 'unknown'

export interface ForkCostRecord {
  ts: number
  agentKey: string | null
  name: string | null
  claudeSessionId: string | null
  context: ForkContext
  turns: number
  tokens: TokenUsage
  cost: number
  /** Wall-clock lifetime in ms. */
  lifeMs: number
}

export interface ForkCostBucket {
  context: ForkContext
  sessions: number
  turns: number
  cacheRead: number
  cacheCreation: number
  input: number
  output: number
  cost: number
  /** cache_read_input_tokens / turns — the number the card asked for. */
  cacheReadPerTurn: number
  costPerTurn: number
}

/** Shape of a session as the ledger sees it (Session or SessionInfo both fit). */
export interface ForkLike {
  agentKey?: string | null
  name?: string | null
  claudeSessionId?: string | null
  parentClaudeSessionId?: string | null
  forkContext?: 'fresh' | 'inherited'
  turnCount?: number
  totalTokens: TokenUsage
  totalCost: number
  createdAt: number
}

export function recordOf(s: ForkLike, now = Date.now()): ForkCostRecord {
  return {
    ts: now,
    agentKey: s.agentKey ?? null,
    name: s.name ?? null,
    claudeSessionId: s.claudeSessionId ?? null,
    context: s.forkContext ?? 'unknown',
    turns: s.turnCount ?? 0,
    tokens: { ...s.totalTokens },
    cost: s.totalCost,
    lifeMs: Math.max(0, now - s.createdAt),
  }
}

export class ForkCostLedger {
  constructor(private file: string) {}

  /** Append one record — call when a FORK session ends for good (not on hibernation). */
  record(s: ForkLike, now = Date.now()): ForkCostRecord {
    const rec = recordOf(s, now)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`)
    } catch { /* best effort — a lost cost line never blocks a session's end */ }
    return rec
  }

  /** Every persisted record (malformed lines skipped). */
  read(): ForkCostRecord[] {
    if (!existsSync(this.file)) return []
    const out: ForkCostRecord[] = []
    for (const line of readFileSync(this.file, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as ForkCostRecord) } catch { /* skip */ }
    }
    return out
  }
}

/** Fold ended records + live forks into one bucket per context mode. */
export function aggregate(records: ForkCostRecord[], live: ForkLike[] = [], opts: { sinceTs?: number } = {}): ForkCostBucket[] {
  const since = opts.sinceTs ?? 0
  const all: ForkCostRecord[] = [
    ...records.filter((r) => r.ts >= since),
    ...live.filter((s) => s.parentClaudeSessionId).map((s) => recordOf(s)),
  ]
  const buckets = new Map<ForkContext, ForkCostBucket>()
  for (const r of all) {
    const b = buckets.get(r.context) ?? { context: r.context, sessions: 0, turns: 0, cacheRead: 0, cacheCreation: 0, input: 0, output: 0, cost: 0, cacheReadPerTurn: 0, costPerTurn: 0 }
    b.sessions++
    b.turns += r.turns
    b.cacheRead += r.tokens.cacheRead ?? 0
    b.cacheCreation += r.tokens.cacheCreation ?? 0
    b.input += r.tokens.input
    b.output += r.tokens.output
    b.cost += r.cost
    buckets.set(r.context, b)
  }
  for (const b of buckets.values()) {
    b.cacheReadPerTurn = b.turns ? Math.round(b.cacheRead / b.turns) : 0
    b.costPerTurn = b.turns ? Number((b.cost / b.turns).toFixed(4)) : 0
  }
  const order: ForkContext[] = ['fresh', 'inherited', 'unknown']
  return [...buckets.values()].sort((a, b) => order.indexOf(a.context) - order.indexOf(b.context))
}
