// Shared utilities for CLI commands

/** `--name` or `--name=value`. Anything else that starts with dashes is TEXT:
 *  a `---` frontmatter fence, a `-- ` signature line, "--force is needed".
 *  Until 10 Oct 2026 every such value was read as the next flag and the flag
 *  it belonged to became the string "true" (^glad-pony wrote a note that way;
 *  `--body` on a chat send would have posted "true"). A value that is exactly
 *  flag-shaped (`--force`) is still a flag: pass it as `--key=--force`. */
const FLAG_RE = /^--[A-Za-z][\w-]*(=|$)/

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
    if (FLAG_RE.test(arg)) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        // --key=value
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else if (i + 1 < args.length && !FLAG_RE.test(args[i + 1]!)) {
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

/** Flags the caller passed that the verb doesn't know — a typo'd or misremembered
 *  flag (`--column` for `--to`) must be a USAGE error, not a silently-dropped
 *  option that lets the command "succeed" with the wrong effect. */
export function unknownFlags(opts: Record<string, string>, allowed: readonly string[]): string[] {
  return Object.keys(opts).filter((k) => !allowed.includes(k))
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
