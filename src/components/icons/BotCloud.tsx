import { createLucideIcon } from 'lucide-react'

// Lucide's Bot riding Lucide's Cloud: the bot is shrunk and lifted into the
// top half, the cloud fills the bottom. Marks a session whose claude process
// runs on forge (the AWS box) rather than this machine. Same 24×24 grid /
// stroke conventions as <Bot/> and <BotCrowned/>, so it reads at 10px.
export const BotCloud = createLucideIcon('BotCloud', [
  ['path', { d: 'M12 4V2H9.5', key: 'antenna' }],
  ['rect', { width: '12', height: '8', x: '6', y: '4', rx: '2', key: 'head' }],
  ['path', { d: 'M4 8h2', key: 'ear-l' }],
  ['path', { d: 'M18 8h2', key: 'ear-r' }],
  ['path', { d: 'M14.5 7v2', key: 'eye-r' }],
  ['path', { d: 'M9.5 7v2', key: 'eye-l' }],
  ['path', { d: 'M6.5 22h11a3.5 3.5 0 0 0 0-7a5.5 5.5 0 0 0-10.3-1.3A4.2 4.2 0 0 0 6.5 22Z', key: 'cloud' }],
])
