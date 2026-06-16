// Pure layout + hit-testing for the visual org chart (a top-down node-link tree).
// Kept free of React/canvas so it's unit-testable. The component decorates each
// laid-out node with live-session status (by joining on key === agentKey).

import { hierarchy, tree } from 'd3-hierarchy'
import type { OrgNode } from '@/store/agent'

export const NODE_W = 176
export const NODE_H = 50
const GAP_X = 28
const LEVEL_H = 104
const MARGIN = 40

export interface OrgLayoutNode {
  key: string
  title: string
  x: number // box center (world coords)
  y: number
  depth: number
  parentKey: string | null
  danglingManager?: string
  cycleBroken?: boolean
}

export interface OrgEdge { x1: number; y1: number; x2: number; y2: number }

export interface OrgLayout {
  nodes: OrgLayoutNode[]
  edges: OrgEdge[]
  width: number
  height: number
}

interface Datum { role: { key: string; title: string } | null; children?: OrgNode[]; danglingManager?: string; cycleBroken?: boolean }

/** Lay the role forest out as one tidy top-down tree (a virtual root joins the
 *  multiple org roots). Returns box centers + parent→child edges in world coords. */
export function buildOrgLayout(treeRoots: OrgNode[]): OrgLayout {
  if (treeRoots.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }
  const rootDatum: Datum = { role: null, children: treeRoots }
  const root = hierarchy<Datum>(rootDatum, (d) => d.children as OrgNode[] | undefined)
  const laid = tree<Datum>().nodeSize([NODE_W + GAP_X, LEVEL_H])(root)

  const real = laid.descendants().filter((n) => n.data.role !== null)
  const xs = real.map((n) => n.x)
  const minX = Math.min(...xs)
  const offsetX = -minX + NODE_W / 2 + MARGIN

  const byD3 = new Map<typeof real[number], OrgLayoutNode>()
  const nodes: OrgLayoutNode[] = real.map((n) => {
    const node: OrgLayoutNode = {
      key: n.data.role!.key,
      title: n.data.role!.title,
      x: n.x + offsetX,
      y: (n.depth - 1) * LEVEL_H + NODE_H / 2 + MARGIN,
      depth: n.depth - 1,
      parentKey: n.parent && n.parent.data.role ? n.parent.data.role.key : null,
      danglingManager: n.data.danglingManager,
      cycleBroken: n.data.cycleBroken,
    }
    byD3.set(n, node)
    return node
  })

  const edges: OrgEdge[] = []
  for (const n of real) {
    if (!n.parent || n.parent.data.role === null) continue
    const child = byD3.get(n)!
    const parent = byD3.get(n.parent)!
    edges.push({ x1: parent.x, y1: parent.y + NODE_H / 2, x2: child.x, y2: child.y - NODE_H / 2 })
  }

  const maxX = Math.max(...nodes.map((n) => n.x))
  const maxY = Math.max(...nodes.map((n) => n.y))
  return { nodes, edges, width: maxX + NODE_W / 2 + MARGIN, height: maxY + NODE_H / 2 + MARGIN }
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
