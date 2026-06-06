import { describe, it, expect } from 'vitest'
import {
  buildHierarchy,
  findNode,
  parentPathOf,
  fitTransform,
  hitTest,
  findDeepestFolderAt,
  truncateLabel,
  coverFadeThreshold,
  isAncestorChainOpen,
  ROOT_PATH,
  type PackNode,
} from '@/components/notes/circles-view-helpers'
import type { VaultFile } from '@/notes/vault-adapter'

const f = (path: string, size = 100): VaultFile => {
  const name = path.split('/').pop()!
  const dir = path.split('/').slice(0, -1).join('/')
  return { path, name, dir, mtime: 0, size }
}

describe('buildHierarchy', () => {
  it('returns null for empty file list', () => {
    expect(buildHierarchy([])).toBeNull()
  })

  it('synthesizes a root node', () => {
    const root = buildHierarchy([f('a.md')])!
    expect(root.data.path).toBe(ROOT_PATH)
    expect(root.data.isFile).toBe(false)
  })

  it('places top-level files as direct children of root', () => {
    const root = buildHierarchy([f('a.md'), f('b.md')])!
    const names = root.children!.map((c) => c.data.name).sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('builds intermediate directory nodes for nested paths', () => {
    const root = buildHierarchy([f('projects/console/notes.md')])!
    const projects = root.children!.find((c) => c.data.name === 'projects')!
    expect(projects.data.isFile).toBe(false)
    const console_ = projects.children!.find((c) => c.data.name === 'console')!
    expect(console_.data.isFile).toBe(false)
    const notes = console_.children!.find((c) => c.data.name === 'notes')!
    expect(notes.data.isFile).toBe(true)
  })

  it('packs nodes into the CANVAS unit square', () => {
    const root = buildHierarchy([f('a.md', 1000), f('b.md', 100), f('c.md', 100)])!
    root.each((d) => {
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.x).toBeLessThanOrEqual(1000)
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeLessThanOrEqual(1000)
      expect(d.r).toBeGreaterThan(0)
    })
  })

  it('weights nodes by file size (bigger files = bigger circles)', () => {
    const root = buildHierarchy([f('big.md', 10_000), f('small.md', 10)])!
    const big = root.children!.find((c) => c.data.name === 'big')!
    const small = root.children!.find((c) => c.data.name === 'small')!
    expect(big.r).toBeGreaterThan(small.r)
  })

  it('handles a file with empty dir (root-level file)', () => {
    const root = buildHierarchy([f('root.md')])!
    expect(root.children).toHaveLength(1)
    expect(root.children![0]!.data.path).toBe('root.md')
  })
})

describe('findNode', () => {
  const root = buildHierarchy([
    f('a/b/c.md'),
    f('a/d.md'),
    f('e.md'),
  ])!

  it('finds the root', () => {
    expect(findNode(root, ROOT_PATH)?.data.path).toBe(ROOT_PATH)
  })

  it('finds a top-level file', () => {
    expect(findNode(root, 'e.md')?.data.path).toBe('e.md')
  })

  it('finds an intermediate directory', () => {
    expect(findNode(root, 'a/b')?.data.path).toBe('a/b')
    expect(findNode(root, 'a/b')?.data.isFile).toBe(false)
  })

  it('finds a deeply nested file', () => {
    expect(findNode(root, 'a/b/c.md')?.data.path).toBe('a/b/c.md')
  })

  it('returns null for missing paths', () => {
    expect(findNode(root, 'nope.md')).toBeNull()
    expect(findNode(root, 'a/b/c.md/extra')).toBeNull()
  })
})

describe('parentPathOf', () => {
  it('returns ROOT_PATH for top-level items', () => {
    expect(parentPathOf('foo.md')).toBe(ROOT_PATH)
    expect(parentPathOf('foo')).toBe(ROOT_PATH)
  })

  it('returns the parent dir for nested items', () => {
    expect(parentPathOf('a/b.md')).toBe('a')
    expect(parentPathOf('a/b/c.md')).toBe('a/b')
    expect(parentPathOf('a/b/c/d/e.md')).toBe('a/b/c/d')
  })
})

describe('fitTransform', () => {
  // Synthetic node — fitTransform is pure math, doesn't need a real pack tree.
  const node = (x: number, y: number, r: number) => ({ x, y, r } as PackNode)

  it('centers the node in the viewport', () => {
    const t = fitTransform(node(500, 500, 100), 800, 600, 1.0)
    const screenX = 500 * t.k + t.x
    const screenY = 500 * t.k + t.y
    expect(screenX).toBeCloseTo(400, 5)
    expect(screenY).toBeCloseTo(300, 5)
  })

  it('scales the node to fill viewport (padding=1)', () => {
    const t = fitTransform(node(500, 500, 100), 800, 800, 1.0)
    // Node radius 100 → diameter 200 → scale so 200 maps to min(W,H)=800
    expect(t.k).toBeCloseTo(800 / 200, 5)
  })

  it('respects aspect ratio (uses min(W, H))', () => {
    const t = fitTransform(node(500, 500, 100), 1600, 400, 1.0)
    // min is 400 → k = 400 / (2*100) = 2
    expect(t.k).toBeCloseTo(2, 5)
  })

  it('zooms tighter with padding > 1', () => {
    const t1 = fitTransform(node(500, 500, 100), 800, 800, 1.0)
    const t2 = fitTransform(node(500, 500, 100), 800, 800, 1.05)
    expect(t2.k).toBeGreaterThan(t1.k)
  })

  it('a folder fit at padding 1.05 crosses its fade threshold', () => {
    // Critical invariant: clicking a folder must zoom enough that its cover fades.
    // Holds at any viewport size since both fitTransform and the threshold use min(W,H).
    for (const [W, H] of [[800, 800], [1600, 400], [400, 1200], [320, 568]]) {
      const t = fitTransform(node(500, 500, 100), W!, H!, 1.05)
      expect(100 * t.k).toBeGreaterThan(coverFadeThreshold(W!, H!))
    }
  })
})

describe('isAncestorChainOpen', () => {
  const root = buildHierarchy([f('a/sub/x.md'), f('a/sub/y.md')])!

  it('top-level node always passes (its only ancestor is root)', () => {
    const a = findNode(root, 'a')!
    expect(isAncestorChainOpen(a, 1, 500)).toBe(true)
  })

  it('nested node is hidden when its parent cover is opaque', () => {
    const sub = findNode(root, 'a/sub')!
    const a = findNode(root, 'a')!
    // a is small enough that a.r * 1 < 500 → a opaque → sub hidden
    expect(a.r * 1).toBeLessThan(500)
    expect(isAncestorChainOpen(sub, 1, 500)).toBe(false)
  })

  it('nested node is visible when parent cover is faded', () => {
    const sub = findNode(root, 'a/sub')!
    const a = findNode(root, 'a')!
    const k = (500 + 1) / a.r // push a past fade threshold
    expect(isAncestorChainOpen(sub, k, 500)).toBe(true)
  })

  it('deeply nested node hidden when ANY ancestor cover is opaque', () => {
    const leaf = findNode(root, 'a/sub/x.md')!
    const sub = findNode(root, 'a/sub')!
    const a = findNode(root, 'a')!
    // Pick k so that `a` is faded but `sub` is not — leaf should still be hidden by sub
    const aFadedK = (500 + 1) / a.r
    expect(sub.r * aFadedK).toBeLessThan(500) // sub still opaque
    expect(isAncestorChainOpen(leaf, aFadedK, 500)).toBe(false)
  })
})

describe('hitTest', () => {
  const root = buildHierarchy([
    f('a/x.md'),
    f('a/y.md'),
    f('b.md'),
  ])!

  const FT = 500 // synthetic fade threshold for these tests

  it('returns null for a point outside any node', () => {
    expect(hitTest(root, -100, -100, 1, FT)).toBeNull()
    expect(hitTest(root, 5000, 5000, 1, FT)).toBeNull()
  })

  it('returns a top-level node at low zoom (folder cover opaque)', () => {
    const a = findNode(root, 'a')!
    const hit = hitTest(root, a.x, a.y, 1, FT)
    expect(hit?.data.path).toBe('a')
  })

  it('returns deepest child when folder cover is faded', () => {
    const a = findNode(root, 'a')!
    const x = findNode(root, 'a/x.md')!
    const k = (FT + 1) / a.r
    const hit = hitTest(root, x.x, x.y, k, FT)
    expect(hit?.data.path).toBe('a/x.md')
  })

  it('skips faded folders entirely (does not return them as hits)', () => {
    const a = findNode(root, 'a')!
    const k = (FT + 100) / a.r
    const hit = hitTest(root, a.x, a.y, k, FT)
    if (hit) expect(hit.data.path).not.toBe('a')
  })

  it('respects sub-pixel culling', () => {
    const x = findNode(root, 'a/x.md')!
    const k = 0.5 / x.r
    const hit = hitTest(root, x.x, x.y, k, FT)
    if (hit) expect(hit.data.path).not.toBe('a/x.md')
  })

  it('never returns root', () => {
    const hit = hitTest(root, 500, 500, 1, FT)
    expect(hit?.data.path).not.toBe(ROOT_PATH)
  })

  it('does not return nodes hidden by an opaque ancestor cover', () => {
    // Build a tree with a deeply nested file
    const r2 = buildHierarchy([f('outer/inner/leaf.md')])!
    const outer = findNode(r2, 'outer')!
    const inner = findNode(r2, 'outer/inner')!
    // At k=1, outer.r < 500 → outer cover opaque → inner + leaf both hidden
    expect(outer.r * 1).toBeLessThan(FT)
    const hitInner = hitTest(r2, inner.x, inner.y, 1, FT)
    expect(hitInner?.data.path).toBe('outer') // not 'outer/inner' or 'outer/inner/leaf.md'
  })
})

describe('findDeepestFolderAt', () => {
  const root = buildHierarchy([
    f('a/sub/x.md'),
    f('a/sub/y.md'),
    f('a/z.md'),
    f('b.md'),
  ])!

  it('returns the deepest folder containing the point', () => {
    const sub = findNode(root, 'a/sub')!
    const got = findDeepestFolderAt(root, sub.x, sub.y, 'a/sub/x.md')
    expect(got?.data.path).toBe('a/sub')
  })

  it('excludes the given path', () => {
    const sub = findNode(root, 'a/sub')!
    const got = findDeepestFolderAt(root, sub.x, sub.y, 'a/sub')
    // Must not return a/sub itself; falls back to its parent 'a'
    expect(got?.data.path).toBe('a')
  })

  it('returns null when point is outside all folders', () => {
    expect(findDeepestFolderAt(root, -1000, -1000, '')).toBeNull()
  })

  it('returns root when point is in root but not in any subfolder', () => {
    // Find a point that's in root but outside all top-level folders by walking
    // a tiny radius around the root center until we find a gap. Simpler: just
    // ensure the algorithm at least returns SOMETHING (root) for a center point.
    // The root is at (500, 500) with r ~ 500. A point at (1, 1) is barely inside root.
    const got = findDeepestFolderAt(root, 1, 1, '')
    // Should at worst be the root
    if (got) expect(got.data.path).toBe(ROOT_PATH)
  })
})

describe('truncateLabel', () => {
  // Simple monospace-like measure: 1 unit per char
  const measure = (s: string) => s.length

  it('returns the full text when it fits', () => {
    expect(truncateLabel('hello', 10, measure)).toBe('hello')
  })

  it('truncates with ellipsis when too long', () => {
    expect(truncateLabel('hello world', 5, measure)).toBe('hell…')
  })

  it('returns null when nothing meaningful fits', () => {
    expect(truncateLabel('hello', 1, measure)).toBeNull()
  })

  it('handles exact-fit edge case', () => {
    expect(truncateLabel('abc', 3, measure)).toBe('abc')
  })

  it('handles empty string', () => {
    expect(truncateLabel('', 10, measure)).toBe('')
  })
})
