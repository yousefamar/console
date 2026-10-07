import { createLucideIcon } from 'lucide-react'

// Lucide's GitBranch sprouting from the same cloud as <BotCloud/>: trunk and
// branch end on the cloud's top contour instead of crossing it. A FORK whose
// claude runs on forge — the cloud base says "remote", the branch says "fork".
export const BranchCloud = createLucideIcon('BranchCloud', [
  ['path', { d: 'M8 13.4V3', key: 'trunk' }],
  ['circle', { cx: '17', cy: '5.5', r: '2.5', key: 'node' }],
  ['path', { d: 'M17 8a6 6 0 0 1-4.6 4.6', key: 'branch' }],
  ['path', { d: 'M5.5 21h13a3.5 3.5 0 0 0 .5-7A14 14 0 0 0 5 14a3.5 3.5 0 0 0 .5 7Z', key: 'cloud' }],
])
