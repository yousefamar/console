// Shared utilities for CLI commands

/**
 * Parse --key value pairs from process.argv (skipping the first N positionals).
 * This bypasses parseArgs' strict:false behavior which eats unknown flags.
 * Handles: --key value, --key=value, --flag (boolean true)
 */
export function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        // --key=value
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
        // --key value
        result[arg.slice(2)] = args[i + 1]!
        i++
      } else {
        // --flag (boolean)
        result[arg.slice(2)] = 'true'
      }
    }
    i++
  }
  return result
}

/**
 * Parse command-specific flags from process.argv.
 * Finds everything after 'con <noun> <verb>' in the raw argv.
 */
export function parseCmdFlags(): Record<string, string> {
  // Find the raw args after the command name
  const argv = process.argv.slice(2) // skip node and script
  return parseFlags(argv)
}

/**
 * Read stdin as a string (for piping content)
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
