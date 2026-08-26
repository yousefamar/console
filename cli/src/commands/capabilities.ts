import { COMMANDS } from './registry.js'
import { output, type GlobalFlags } from '../output.js'

export function capabilities(flags: GlobalFlags): void {
  // Derived from the registry so a new command group can't be forgotten here
  // (spaces/board was invisible to self-discovering agents for months).
  const services = [...new Set(COMMANDS.map((cmd) => cmd.name.split(' ')[0]!))]
  const data = {
    version: '0.1.0',
    services,
    aliases: { board: 'spaces board' },
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
