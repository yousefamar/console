// Pure layout + hit-testing for the visual org chart (a left-to-right node-link
// tree). Kept free of React/canvas so it's unit-testable. Builds the display
// hierarchy from the flat role list: Al is the root; real `manager` edges nest
// agents under their managers; every other (managerless) agent is clustered into
// a synthetic DIRECTORY FOLDER node (by its cwd) under Al, so life projects land
// in one place. Folders are organization-only — not real roles.

import { hierarchy, tree } from 'd3-hierarchy'
import type { AgentRole } from '@/store/agent'

export const NODE_W = 176
export const NODE_H = 50
export const TOGGLE_R = 11   // collapse/expand toggle hit radius (on a node's right edge)
const ROW_GAP = 16   // vertical gap between stacked siblings
const COL_GAP = 56   // horizontal gap between depth levels
const MARGIN = 32

export type NodeKind = 'al' | 'role' | 'group'

export interface OrgLayoutNode {
  key: string            // role key, or synthetic 'dir:<path>' for a folder
  title: string
  kind: NodeKind
  x: number              // box center (world coords)
  y: number
  depth: number
  parentKey: string | null
  danglingManager?: string
  cycleBroken?: boolean
  childCount?: number      // for folders: how many agents inside
  hasChildren?: boolean    // has children in the FULL tree (shows a collapse toggle)
  collapsed?: boolean      // currently collapsed (subtree hidden)
  descendantCount?: number // total descendants in the full tree (collapsed badge)
}

export interface OrgEdge { x1: number; y1: number; x2: number; y2: number }

export interface OrgLayout {
  nodes: OrgLayoutNode[]
  edges: OrgEdge[]
  width: number
  height: number
}

interface BuildNode {
  id: string
  kind: NodeKind
  title: string
  children: BuildNode[]
  danglingManager?: string
  childCount?: number
}

/** Build the display tree from the flat roles: Al is the root; `manager` edges
 *  nest agents and folders alike; managerless non-Al nodes hang under Al. Folders
 *  are real roles flagged `folder` (rendered as kind 'group'). */
function buildDisplayRoot(roles: AgentRole[]): BuildNode | null {
  if (roles.length === 0) return null
  const byKey = new Map(roles.map((r) => [r.key, r]))
  const nodeOf = new Map<string, BuildNode>()
  for (const r of roles) nodeOf.set(r.key, { id: r.key, kind: r.key === 'al' ? 'al' : r.folder ? 'group' : 'role', title: r.title, children: [] })

  // Resolve a role's manager to a valid, non-cyclic ancestor key (or null).
  const validManager = (r: AgentRole): string | null => {
    if (!r.manager || r.manager === r.key || !byKey.has(r.manager)) return null
    const seen = new Set<string>([r.key])
    let cur: AgentRole | undefined = byKey.get(r.manager)
    while (cur) {
      if (seen.has(cur.key)) return null // cycle → treat as top-level
      seen.add(cur.key)
      cur = cur.manager && byKey.has(cur.manager) ? byKey.get(cur.manager) : undefined
    }
    return r.manager
  }

  const root = nodeOf.get('al') ?? { id: 'al', kind: 'al' as NodeKind, title: 'Agents', children: [] }
  for (const r of roles) {
    if (r.key === 'al') continue
    const node = nodeOf.get(r.key)!
    const mgr = validManager(r)
    if (mgr) {
      nodeOf.get(mgr)!.children.push(node)
    } else {
      if (r.manager && !byKey.has(r.manager)) node.danglingManager = r.manager
      root.children.push(node) // managerless / dangling → under Al
    }
  }

  const byTitle = (a: BuildNode, b: BuildNode) => {
    // folders first within a level, then by title
    if ((a.kind === 'group') !== (b.kind === 'group')) return a.kind === 'group' ? -1 : 1
    return a.title.localeCompare(b.title)
  }
  const sortRec = (n: BuildNode) => { n.children.sort(byTitle); n.children.forEach(sortRec) }
  sortRec(root)
  return root
}

/** Prune the display tree to branches that lead to a filtered (alerted) node.
 *  A node survives if it's itself in `keys`, or any descendant is — so matched
 *  nodes stay visible in their full org context (ancestor chain to Al). The root
 *  (Al) is always kept. Mutates the freshly-built tree in place. */
function pruneToFilter(root: BuildNode, keys: Set<string>) {
  const keep = (n: BuildNode): boolean => {
    n.children = n.children.filter(keep)
    return keys.has(n.id) || n.children.length > 0
  }
  root.children = root.children.filter(keep)
}

/** Lay the display tree out left-to-right (depth → x, siblings → y). Collapsed
 *  node keys have their subtrees pruned from the layout (but counted). When
 *  `filterKeys` is provided (even empty), the tree is pruned to only the
 *  branches reaching those keys — the "needs me" focus view. */
export function buildOrgLayout(roles: AgentRole[], collapsed: Set<string> = new Set(), filterKeys: Set<string> | null = null): OrgLayout {
  const root = buildDisplayRoot(roles)
  if (!root) return { nodes: [], edges: [], width: 0, height: 0 }
  if (filterKeys) pruneToFilter(root, filterKeys)
  // Total descendants per node (full tree) — for the collapsed "+N" badge.
  const descCount = new Map<string, number>()
  const countDesc = (n: BuildNode): number => {
    let c = 0
    for (const ch of n.children) c += 1 + countDesc(ch)
    descCount.set(n.id, c)
    return c
  }
  countDesc(root)
  // Prune collapsed subtrees from the layout via the children accessor.
  const h = hierarchy<BuildNode>(root, (d) => (collapsed.has(d.id) ? undefined : d.children))
  const laid = tree<BuildNode>().nodeSize([NODE_H + ROW_GAP, NODE_W + COL_GAP])(h)

  const all = laid.descendants()
  const ys = all.map((n) => n.x) // breadth
  const minY = Math.min(...ys)
  const offsetY = -minY + NODE_H / 2 + MARGIN

  const byD3 = new Map<typeof all[number], OrgLayoutNode>()
  const nodes: OrgLayoutNode[] = all.map((n) => {
    const node: OrgLayoutNode = {
      key: n.data.id,
      title: n.data.title,
      kind: n.data.kind,
      x: n.depth * (NODE_W + COL_GAP) + NODE_W / 2 + MARGIN,
      y: n.x + offsetY,
      depth: n.depth,
      parentKey: n.parent ? n.parent.data.id : null,
      danglingManager: n.data.danglingManager,
      childCount: n.data.kind === 'group' ? (n.data.children?.length ?? 0) : undefined,
      hasChildren: (n.data.children?.length ?? 0) > 0,
      collapsed: collapsed.has(n.data.id),
      descendantCount: descCount.get(n.data.id) ?? 0,
    }
    byD3.set(n, node)
    return node
  })

  const edges: OrgEdge[] = []
  for (const n of all) {
    if (!n.parent) continue
    const child = byD3.get(n)!
    const parent = byD3.get(n.parent)!
    edges.push({ x1: parent.x + NODE_W / 2, y1: parent.y, x2: child.x - NODE_W / 2, y2: child.y })
  }

  const maxX = Math.max(...nodes.map((n) => n.x))
  const maxY = Math.max(...nodes.map((n) => n.y))
  return { nodes, edges, width: maxX + NODE_W / 2 + MARGIN, height: maxY + NODE_H / 2 + MARGIN }
}

/** A collapse/expand toggle hit (the circle on a parent node's right edge), if any. */
export function hitToggle(nodes: OrgLayoutNode[], x: number, y: number): OrgLayoutNode | null {
  for (const n of nodes) {
    if (!n.hasChildren) continue
    const cx = n.x + NODE_W / 2
    if ((x - cx) ** 2 + (y - n.y) ** 2 <= (TOGGLE_R + 3) ** 2) return n
  }
  return null
}

/** The node whose box contains the point, if any. */
export function hitTest(nodes: OrgLayoutNode[], x: number, y: number, exclude?: Set<string>): OrgLayoutNode | null {
  for (const n of nodes) {
    if (exclude?.has(n.key)) continue
    if (x >= n.x - NODE_W / 2 && x <= n.x + NODE_W / 2 && y >= n.y - NODE_H / 2 && y <= n.y + NODE_H / 2) return n
  }
  return null
}

/** Keys of the subtree rooted at `key` (inclusive) — the illegal drop targets
 *  when reparenting `key` (can't become its own descendant). */
export function subtreeKeys(nodes: OrgLayoutNode[], key: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentKey) {
      const arr = childrenOf.get(n.parentKey) ?? []
      arr.push(n.key)
      childrenOf.set(n.parentKey, arr)
    }
  }
  const out = new Set<string>()
  const walk = (k: string) => { out.add(k); for (const c of childrenOf.get(k) ?? []) walk(c) }
  walk(key)
  return out
}
