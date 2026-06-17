// ============================================================================
// Delegation routing — pure helpers (depth/cycle guard, chain building, labels).
//
// The orchestration that touches sessions (delegateTask / reportTask /
// runTaskWatchdog) lives in routes/agents.ts beside createSession/reviveAgentRole
// to avoid an import cycle (mirrors the reviveAgentRole decision there). These
// pure pieces are unit-tested in isolation.
// ============================================================================

/** Hard cap on chain depth — a runaway-delegation backstop (mirrors the model
 *  restart cap). Yousef → Al → … is already 2 levels, so 6 allows deep orgs. */
export const MAX_DEPTH = 6

export interface DelegationCheck { ok: boolean; error?: string }

/** Reject a delegation that would cycle (assignee already in the chain) or
 *  exceed the depth cap. `chain` is the path that WOULD lead to `toKey` (i.e. the
 *  delegator's chain, before appending `toKey`). */
export function checkDelegation(chainBeforeTo: string[], fromKey: string, toKey: string, maxDepth = MAX_DEPTH): DelegationCheck {
  if (!toKey) return { ok: false, error: 'delegation needs an assignee' }
  if (toKey === fromKey) return { ok: false, error: 'an agent cannot delegate to itself' }
  if (chainBeforeTo.includes(toKey)) return { ok: false, error: `cycle: "${toKey}" is already in the delegation chain` }
  if (chainBeforeTo.length >= maxDepth) return { ok: false, error: `delegation too deep (max ${maxDepth} levels)` }
  return { ok: true }
}

/** Build the chain of agentKeys ending at the assignee. For a top-level
 *  delegation, `parentChain` is undefined → [fromKey]. For a sub-delegation, the
 *  parent task's chain already ends at `fromKey` → just append `toKey`. */
export function buildChain(parentChain: string[] | undefined, fromKey: string, toKey: string): string[] {
  const base = parentChain && parentChain.length ? [...parentChain] : [fromKey]
  if (base[base.length - 1] !== fromKey) base.push(fromKey)
  return [...base, toKey]
}

/** Human-readable chain for an envelope, e.g. "Yousef → Al → Engineering → you".
 *  The last hop (the reader) is rendered as "you". */
export function chainLabel(chain: string[], titleFor: (key: string) => string, origin: 'human' | 'agent'): string {
  const parts = chain.map((k, i) => (i === chain.length - 1 ? 'you' : titleFor(k)))
  return (origin === 'human' ? ['Yousef', ...parts] : parts).join(' → ')
}
