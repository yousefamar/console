/** Fork-tree lineage helpers (parentClaudeSessionId chains). */

export interface LineageNode {
  claudeSessionId?: string
  parentClaudeSessionId?: string
}

/** True if making `parent` the parent of `child` would close a loop — i.e.
 *  `parent` is `child` itself or one of its descendants (walks upward from
 *  `parent`, bounded by the map so a pre-existing loop can't spin forever). */
export function wouldCycle<T extends LineageNode>(child: T, parent: T, byClaudeId: Map<string, T>): boolean {
  const seen = new Set<T>()
  for (let p: T | undefined = parent; p && !seen.has(p); p = p.parentClaudeSessionId ? byClaudeId.get(p.parentClaudeSessionId) : undefined) {
    if (p === child) return true
    seen.add(p)
  }
  return false
}
