import { createLucideIcon } from 'lucide-react'

// The cloud IS the bot: Lucide's Cloud wearing Bot's antenna and eyes. A
// top-level session whose claude runs on forge (the AWS box).
export const BotCloud = createLucideIcon('BotCloud', [
  ['path', { d: 'M17.5 21H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z', key: 'cloud' }],
  ['path', { d: 'M9 7V4H6.5', key: 'antenna' }],
  ['path', { d: 'M10 15v2', key: 'eye-l' }],
  ['path', { d: 'M15 15v2', key: 'eye-r' }],
])
