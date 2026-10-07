import { createLucideIcon } from 'lucide-react'

// Lucide's GitBranch whose branched-off node is a cloud: the fork went to the
// cloud. A FORK whose claude runs on forge; the trunk node stays local.
export const BranchCloud = createLucideIcon('BranchCloud', [
  ['path', { d: 'M6 3v12', key: 'trunk' }],
  ['circle', { cx: '6', cy: '18', r: '3', key: 'root' }],
  ['path', { d: 'M17 11a8 8 0 0 1-8 7', key: 'branch' }],
  ['path', { d: 'M13.5 11h7a2.5 2.5 0 0 0 .3-5A4 4 0 0 0 13.6 5a3 3 0 0 0-.1 6Z', key: 'cloud' }],
])
