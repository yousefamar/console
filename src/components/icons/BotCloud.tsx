import { createLucideIcon } from 'lucide-react'

// Lucide's Bot sitting in a cloud: the head's sides stop where the cloud's
// top contour passes in front of them (occlusion, no crossing strokes), so it
// reads as one silhouette at 10px. A session whose claude runs on forge.
// Shares its cloud with <BranchCloud/>: the cloud base means "remote".
export const BotCloud = createLucideIcon('BotCloud', [
  ['path', { d: 'M7 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v7', key: 'head' }],
  ['path', { d: 'M4 8h2', key: 'ear-l' }],
  ['path', { d: 'M18 8h2', key: 'ear-r' }],
  ['path', { d: 'M10 7v2', key: 'eye-l' }],
  ['path', { d: 'M14 7v2', key: 'eye-r' }],
  ['path', { d: 'M5.5 21h13a3.5 3.5 0 0 0 .5-7A14 14 0 0 0 5 14a3.5 3.5 0 0 0 .5 7Z', key: 'cloud' }],
])
