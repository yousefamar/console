// Pure helpers for CirclesView — extracted so they can be unit-tested
// without a DOM / canvas dependency.

import { pack, stratify, type HierarchyCircularNode } from 'd3-hierarchy'
import { zoomIdentity, type ZoomTransform } from 'd3-zoom'
import type { VaultFile } from '@/notes/vault-adapter'

export const ROOT_PATH = '__root__'
export const CANVAS = 1000
export const PADDING = 8

// The apparent radius (node.r * zoomK) above which a folder's cover fades and
// its children become visible. Scales with the viewport so the invariant
// "clicking a folder zooms past the threshold" holds at any size.
// Fraction 0.4 means the cover fades once the folder fills ~80% of the
// viewport's short side — early enough that wheel-zooming reveals children
// before they need to fill the whole screen.
export function coverFadeThreshold(W: number, H: number): number {
  return Math.min(W, H) * 0.4
}

export interface NodeDatum {
  path: string
  isFile: boolean
  size: number
  mtime: number
  name: string
}

export type PackNode = HierarchyCircularNode<NodeDatum>

// ---------------------------------------------------------------------------
// Build a packed hierarchy from a flat VaultFile list. Synthesizes intermediate
// directory nodes and a root node. File sizes drive the pack layout's weight.
// ---------------------------------------------------------------------------
export function buildHierarchy(files: VaultFile[]): PackNode | null {
  if (files.length === 0) return null

  const nodes = new Map<string, NodeDatum>()
  nodes.set(ROOT_PATH, { path: ROOT_PATH, isFile: false, size: 0, mtime: 0, name: 'vault' })

  for (const f of files) {
    nodes.set(f.path, {
      path: f.path,
      isFile: true,
      size: Math.max(1, f.size),
      mtime: f.mtime,
      name: f.name.replace(/\.md$/i, ''),
    })
    const parts = f.dir ? f.dir.split('/').filter(Boolean) : []
    for (let i = 0; i < parts.length; i++) {
      const dirPath = parts.slice(0, i + 1).join('/')
      if (!nodes.has(dirPath)) {
        nodes.set(dirPath, { path: dirPath, isFile: false, size: 0, mtime: 0, name: parts[i] ?? '' })
      }
    }
  }

  const root = stratify<NodeDatum>()
    .id((d) => d.path)
    .parentId((d) => {
      if (d.path === ROOT_PATH) return null
      const idx = d.path.lastIndexOf('/')
      return idx < 0 ? ROOT_PATH : d.path.slice(0, idx)
    })([...nodes.values()])

  root.sum((d) => (d.isFile ? d.size : 0))
  root.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  return pack<NodeDatum>().size([CANVAS, CANVAS]).padding(PADDING)(root) as PackNode
}

// ---------------------------------------------------------------------------
// Find a node by its path. Returns null if absent.
// ---------------------------------------------------------------------------
export function findNode(root: PackNode, path: string): PackNode | null {
  let found: PackNode | null = null
  root.each((d) => {
    if (d.data.path === path) found = d as PackNode
  })
  return found
}

// ---------------------------------------------------------------------------
// Parent path of a path string. Returns ROOT_PATH for top-level items.
// ---------------------------------------------------------------------------
export function parentPathOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? ROOT_PATH : path.slice(0, idx)
}

// ---------------------------------------------------------------------------
// d3-zoom transform that fits `node` into a [W, H] viewport. `padding > 1`
// zooms slightly tighter so the focused folder's apparent radius clears
// COVER_FADE_THRESHOLD and its cover fades, revealing children.
// ---------------------------------------------------------------------------
export function fitTransform(node: PackNode, W: number, H: number, padding = 1.05): ZoomTransform {
  const k = (Math.min(W, H) / (2 * node.r)) * padding
  const tx = W / 2 - node.x * k
  const ty = H / 2 - node.y * k
  return zoomIdentity.translate(tx, ty).scale(k)
}

// ---------------------------------------------------------------------------
// True iff `node` is on the currently-visible level — i.e. every ancestor
// (except root) has its cover faded. If any ancestor's cover is opaque, it
// covers `node` visually, so `node` is not visible even if its own circle
// would otherwise be drawn.
// ---------------------------------------------------------------------------
export function isAncestorChainOpen(node: PackNode, k: number, fadeThreshold: number): boolean {
  let p = node.parent as PackNode | null
  while (p) {
    if (!p.parent) return true // reached root — root cover is always transparent
    if (p.r * k <= fadeThreshold) return false // ancestor's opaque cover hides us
    p = p.parent as PackNode | null
  }
  return true
}

// ---------------------------------------------------------------------------
// Hit-test in user-space coords. Returns the deepest non-faded *visible* node
// containing the point. A node is "visible" iff its ancestors' covers are all
// faded (otherwise some ancestor covers it). Skips sub-pixel nodes and the
// root itself.
// ---------------------------------------------------------------------------
export function hitTest(
  root: PackNode,
  ux: number,
  uy: number,
  k: number,
  fadeThreshold: number,
): PackNode | null {
  let best: PackNode | null = null
  let bestDepth = -1
  root.each((d) => {
    if (!d.parent) return
    const apparentR = d.r * k
    if (apparentR < 0.6) return
    const isFaded = !!d.children && apparentR > fadeThreshold
    if (isFaded) return
    if (!isAncestorChainOpen(d as PackNode, k, fadeThreshold)) return
    const dx = ux - d.x
    const dy = uy - d.y
    if (dx * dx + dy * dy <= d.r * d.r) {
      if (d.depth > bestDepth) {
        best = d as PackNode
        bestDepth = d.depth
      }
    }
  })
  return best
}

// ---------------------------------------------------------------------------
// Find the deepest folder containing a point, excluding a given path (used to
// avoid dropping a file on itself or its current parent).
// ---------------------------------------------------------------------------
export function findDeepestFolderAt(
  root: PackNode,
  x: number,
  y: number,
  excludePath: string,
): PackNode | null {
  let best: PackNode | null = null
  let bestDepth = -1
  root.each((d) => {
    if (d.data.isFile) return
    if (d.data.path === excludePath) return
    const dx = x - d.x
    const dy = y - d.y
    if (dx * dx + dy * dy <= d.r * d.r) {
      if (d.depth > bestDepth) {
        best = d as PackNode
        bestDepth = d.depth
      }
    }
  })
  return best
}

// ---------------------------------------------------------------------------
// Truncate a label to fit within maxWidth pixels, using a measure function.
// Returns null if even a single character + ellipsis won't fit.
// ---------------------------------------------------------------------------
export function truncateLabel(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string | null {
  if (measure(text) <= maxWidth) return text
  // Binary search for the longest prefix that fits with an ellipsis
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measure(text.slice(0, mid) + '…') <= maxWidth) lo = mid
    else hi = mid - 1
  }
  if (lo < 2) return null
  return text.slice(0, lo) + '…'
}
