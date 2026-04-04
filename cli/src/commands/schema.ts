import { COMMANDS } from './registry.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'

export function schema(command: string | undefined, flags: GlobalFlags): void {
  if (!command) {
    // Return schema for all commands
    output(COMMANDS, flags)
    return
  }

  // Normalize: mail.list → mail list
  const normalized = command.replace(/\./g, ' ')
  const cmd = COMMANDS.find((c) => c.name === normalized)

  if (!cmd) {
    exitWithError('NOT_FOUND', `Unknown command: ${command}. Use 'con schema' to list all.`, flags)
  }

  const schema: Record<string, unknown> = {
    command: cmd.name,
    description: cmd.description,
    safety: cmd.safety,
  }

  if (cmd.args) {
    schema.arguments = cmd.args
  }

  if (cmd.flags) {
    schema.flags = cmd.flags
  }

  if (cmd.examples) {
    schema.examples = cmd.examples
  }

  output(schema, flags)
}
