// Sidebar session ordering — pure, shared by the AgentTab list render AND the
// j/k cycling in the store, so "next/prev session" matches what's on screen.
//
// Order = sessions clustered by cwd into a group tree (ordered within + across
// groups by the persisted flat `sessionOrder`), with fork lineage nesting each
// fork right after its parent. `flattenSidebarOrder` walks that tree in render
// order to produce the flat list a user sees top-to-bottom.

import type { SessionInfo } from '@/store/agent'

export interface GroupNode {
  cwd: string                  // '' = "no directory" bucket
  label: string                // path segment relative to parent
  fullPath: string             // for tooltip
  sessions: SessionInfo[]
  children: GroupNode[]
  depth: number
}

function dirBasename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function buildGroupTree(sessions: SessionInfo[], order: string[]): GroupNode[] {
  const orderIdx = new Map(order.map((id, i) => [id, i]))
  const sessionKey = (s: SessionInfo) => orderIdx.get(s.id) ?? Number.MAX_SAFE_INTEGER
  const sortSessions = (a: SessionInfo, b: SessionInfo) => {
    const ai = sessionKey(a)
    const bi = sessionKey(b)
    if (ai !== bi) return ai - bi
    return b.createdAt - a.createdAt
  }

  // Bucket by cwd
  const byCwd = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const cwd = s.cwd ?? ''
    const arr = byCwd.get(cwd) ?? []
    arr.push(s)
    byCwd.set(cwd, arr)
  }
  for (const arr of byCwd.values()) arr.sort(sortSessions)

  // Sort cwds shortest-first so each node's parent already exists when we link
  const cwds = [...byCwd.keys()].sort((a, b) => a.length - b.length)
  const nodeByCwd = new Map<string, GroupNode>()
  for (const cwd of cwds) {
    nodeByCwd.set(cwd, {
      cwd,
      label: cwd ? dirBasename(cwd) : '(no directory)',
      fullPath: cwd,
      sessions: byCwd.get(cwd)!,
      children: [],
      depth: 0,
    })
  }

  const roots: GroupNode[] = []
  for (const cwd of cwds) {
    const node = nodeByCwd.get(cwd)!
    // Find longest *sessioned* cwd that is a strict ancestor
    let parentCwd: string | null = null
    if (cwd) {
      for (const other of cwds) {
        if (!other || other === cwd) continue
        if (cwd.startsWith(other + '/') && (parentCwd === null || other.length > parentCwd.length)) {
          parentCwd = other
        }
      }
    }
    if (parentCwd !== null) {
      const parent = nodeByCwd.get(parentCwd)!
      parent.children.push(node)
      node.depth = parent.depth + 1
      node.label = cwd.slice(parentCwd.length + 1)
    } else {
      roots.push(node)
    }
  }

  // Group sort key: first-member's order index, recursing into children if empty
  const groupKey = (n: GroupNode): number => {
    if (n.sessions.length > 0) return sessionKey(n.sessions[0]!)
    if (n.children.length > 0) return groupKey(n.children[0]!)
    return Number.MAX_SAFE_INTEGER
  }
  const sortGroupsRec = (arr: GroupNode[]) => {
    arr.sort((a, b) => groupKey(a) - groupKey(b))
    for (const n of arr) sortGroupsRec(n.children)
  }
  sortGroupsRec(roots)

  return roots
}

/** If the tree has a single root (one cwd shared by everything), drop its
 *  redundant header — promote its sessions to the top level (alongside Al)
 *  and its child groups become the new roots. */
export function peelUniversalRoot(roots: GroupNode[]): { rootSessions: SessionInfo[]; roots: GroupNode[] } {
  if (roots.length !== 1) return { rootSessions: [], roots }
  const only = roots[0]!
  const promoted = only.children.map((c) => shiftDepth(c, -1))
  return { rootSessions: only.sessions, roots: promoted }
}

function shiftDepth(node: GroupNode, delta: number): GroupNode {
  return {
    ...node,
    depth: node.depth + delta,
    children: node.children.map((c) => shiftDepth(c, delta)),
  }
}

/** Arrange a flat list of sessions (all sharing one cwd group) into a fork
 *  lineage: each fork is emitted right after its parent, one indent deeper.
 *  Preserves the incoming order for roots; a fork whose parent isn't in this
 *  list is treated as a root. */
export function arrangeLineage(sessions: SessionInfo[]): Array<{ session: SessionInfo; depth: number }> {
  const inSet = new Set(sessions.map((s) => s.claudeSessionId).filter(Boolean) as string[])
  const childrenOf = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const p = s.parentClaudeSessionId
    if (p && inSet.has(p)) {
      const arr = childrenOf.get(p) ?? []
      arr.push(s)
      childrenOf.set(p, arr)
    }
  }
  const out: Array<{ session: SessionInfo; depth: number }> = []
  const emit = (s: SessionInfo, depth: number) => {
    out.push({ session: s, depth })
    if (s.claudeSessionId) {
      for (const child of childrenOf.get(s.claudeSessionId) ?? []) emit(child, depth + 1)
    }
  }
  for (const s of sessions) {
    const isRoot = !s.parentClaudeSessionId || !inSet.has(s.parentClaudeSessionId)
    if (isRoot) emit(s, 0)
  }
  return out
}

/** The flat, top-to-bottom order of sessions as the sidebar renders them
 *  (excludes Al — callers prepend it). Collapsed groups are skipped (their
 *  sessions + children are hidden in the UI), so cycling matches what's visible. */
export function flattenSidebarOrder(sessions: SessionInfo[], order: string[], collapsedGroups?: Set<string>): SessionInfo[] {
  const { rootSessions, roots } = peelUniversalRoot(buildGroupTree(sessions, order))
  const out: SessionInfo[] = []
  for (const { session } of arrangeLineage(rootSessions)) out.push(session)
  const walk = (nodes: GroupNode[]) => {
    for (const n of nodes) {
      if (collapsedGroups?.has(n.cwd)) continue
      for (const { session } of arrangeLineage(n.sessions)) out.push(session)
      walk(n.children)
    }
  }
  walk(roots)
  return out
}
