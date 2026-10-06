import { createLucideIcon } from 'lucide-react'

// Lucide's GitBranch growing out of Lucide's Cloud: the stem rises from the
// cloud top and the side branch curves off to its node. Marks a FORK whose
// claude process runs on forge — remoteness and lineage are separate axes, so
// a remote fork must not fall back to the plain branch (<GitBranch/>) or the
// top-level remote glyph (<BotCloud/>). Same 24×24 grid / stroke conventions.
export const BranchCloud = createLucideIcon('BranchCloud', [
  ['path', { d: 'M9 14V3', key: 'stem' }],
  ['circle', { cx: '16', cy: '6', r: '2.5', key: 'node' }],
  ['path', { d: 'M16 8.5A7 7 0 0 1 9 14', key: 'branch' }],
  ['path', { d: 'M6.5 22h11a3.5 3.5 0 0 0 0-7a5.5 5.5 0 0 0-10.3-1.3A4.2 4.2 0 0 0 6.5 22Z', key: 'cloud' }],
])
