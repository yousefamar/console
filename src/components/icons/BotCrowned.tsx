import { createLucideIcon } from 'lucide-react'

// Lucide's Bot wearing Lucide's Crown: the antenna is dropped and the head
// rect sits two units lower so a three-point crown fits above it. Same
// 24×24 grid / stroke conventions, so it takes size/className like any
// lucide icon and reads at 10px beside plain <Bot/> rows.
export const BotCrowned = createLucideIcon('BotCrowned', [
  ['path', { d: 'M6.5 9.5 5.5 3.5 9.5 6.5 12 2.5l2.5 4 4-3-1 6', key: 'crown' }],
  ['path', { d: 'M6.5 9.5h11', key: 'crown-base' }],
  ['rect', { width: '16', height: '12', x: '4', y: '10', rx: '2', key: 'head' }],
  ['path', { d: 'M2 16h2', key: 'ear-l' }],
  ['path', { d: 'M20 16h2', key: 'ear-r' }],
  ['path', { d: 'M15 15v2', key: 'eye-r' }],
  ['path', { d: 'M9 15v2', key: 'eye-l' }],
])
