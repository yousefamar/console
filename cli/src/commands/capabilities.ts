import { COMMANDS } from './registry.js'
import { output, type GlobalFlags } from '../output.js'

export function capabilities(flags: GlobalFlags): void {
  const data = {
    version: '0.1.0',
    services: ['mail', 'chat', 'bookmarks', 'notes', 'feeds', 'cal', 'agent'],
    commands: COMMANDS.map((cmd) => ({
      name: cmd.name,
      safety: cmd.safety,
      description: cmd.description,
    })),
    safetyTiers: {
      read: 'Always allowed',
      write: 'Modifies data',
      destructive: 'Permanently deletes data',
    },
  }

  output(data, { ...flags, json: true })
}
