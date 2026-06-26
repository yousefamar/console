#!/usr/bin/env node
// con — Console CLI for AI agents and power users

import { HubError, HubUnavailableError } from './client.js'
import { type GlobalFlags, EXIT, exitWithError, outputError } from './output.js'
import { ALIASES } from './commands/registry.js'

const VERSION = '0.1.0'

// --------------------------------------------------------------------------
// Parse global flags + positional args
// --------------------------------------------------------------------------

// Global flags known to the dispatcher — everything else passes through to commands
const GLOBAL_FLAGS = new Set(['--json', '--plain', '--no-color', '--agent', '--dry-run', '--no-input', '--verbose', '-h', '--help', '-v', '--version'])
const GLOBAL_FLAGS_WITH_VALUE = new Set(['--select', '--hub', '--timeout'])

function parseGlobalFlags(): { flags: GlobalFlags; positionals: string[] } {
  const argv = process.argv.slice(2)
  const flags: GlobalFlags = {
    json: false, plain: false, noColor: false, agent: false,
    dryRun: false, noInput: false, verbose: false, timeout: 30000,
  }
  const positionals: string[] = []

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (GLOBAL_FLAGS.has(arg)) {
      if (arg === '--json') flags.json = true
      else if (arg === '--plain') flags.plain = true
      else if (arg === '--no-color') flags.noColor = true
      else if (arg === '--agent') { flags.agent = true; flags.json = true; flags.noInput = true }
      else if (arg === '--dry-run') flags.dryRun = true
      else if (arg === '--no-input') flags.noInput = true
      else if (arg === '--verbose') flags.verbose = true
      i++
    } else if (GLOBAL_FLAGS_WITH_VALUE.has(arg) && i + 1 < argv.length) {
      if (arg === '--select') flags.select = argv[i + 1]!
      else if (arg === '--hub') flags.hub = argv[i + 1]!
      else if (arg === '--timeout') flags.timeout = parseInt(argv[i + 1]!, 10)
      i += 2
    } else {
      // Everything else (positionals + command-specific flags) passes through
      positionals.push(arg)
      i++
    }
  }

  return { flags, positionals }
}

// --------------------------------------------------------------------------
// Command dispatch
// --------------------------------------------------------------------------

async function main() {
  const { flags, positionals } = parseGlobalFlags()

  // Set hub URL from flag or env
  if (flags.hub) {
    process.env.CONSOLE_HUB_URL = flags.hub
  }

  // Handle --version
  if (positionals[0] === 'version' || positionals.includes('--version') || positionals.includes('-v')) {
    const { version } = await import('./commands/status.js')
    version(flags)
    return
  }

  // Handle --help or no args
  if (positionals.length === 0 || positionals[0] === 'help') {
    const { help } = await import('./commands/help.js')
    help(positionals.slice(1), flags)
    return
  }

  // Resolve aliases
  let noun = positionals[0]!
  if (ALIASES[noun]) noun = ALIASES[noun]!

  const verb = positionals[1]
  const rest = positionals.slice(2)

  try {
    switch (noun) {
      case 'mail': {
        const { mail } = await import('./commands/mail.js')
        await mail(verb, rest, flags)
        break
      }
      case 'chat': {
        const { chat } = await import('./commands/chat.js')
        await chat(verb, rest, flags)
        break
      }
      case 'bookmarks': {
        const { bookmarks } = await import('./commands/bookmarks.js')
        await bookmarks(verb, rest, flags)
        break
      }
      case 'notes': {
        const { notes } = await import('./commands/notes.js')
        await notes(verb, rest, flags)
        break
      }
      case 'feeds': {
        const { feeds } = await import('./commands/feeds.js')
        await feeds(verb, rest, flags)
        break
      }
      case 'cal': {
        const { cal } = await import('./commands/cal.js')
        await cal(verb, rest, flags)
        break
      }
      case 'agent': {
        const { agent } = await import('./commands/agent.js')
        await agent(verb, rest, flags)
        break
      }
      case 'money': {
        const { money } = await import('./commands/money.js')
        await money(verb, rest, flags)
        break
      }
      case 'glasses': {
        const { glasses } = await import('./commands/glasses.js')
        await glasses(verb, rest, flags)
        break
      }
      case 'pen': {
        const { pen } = await import('./commands/pen.js')
        await pen(verb, rest, flags)
        break
      }
      case 'whatsapp': {
        const { whatsapp } = await import('./commands/whatsapp.js')
        await whatsapp(verb, rest, flags)
        break
      }
      case 'mic': {
        const { mic } = await import('./commands/mic.js')
        await mic(verb, rest, flags)
        break
      }
      case 'search': {
        const { search } = await import('./commands/search.js')
        await search([verb, ...rest].filter(Boolean) as string[], flags)
        break
      }
      case 'auth': {
        const { auth } = await import('./commands/auth.js')
        await auth(verb, rest, flags)
        break
      }
      case 'status': {
        const { status } = await import('./commands/status.js')
        await status(flags)
        break
      }
      case 'hub': {
        const { hub } = await import('./commands/hub.js')
        await hub(verb, rest, flags)
        break
      }
      case 'dashboard': {
        const { dashboard } = await import('./commands/dashboard.js')
        await dashboard(verb, rest, flags)
        break
      }
      case 'cron': {
        const { cron } = await import('./commands/cron.js')
        await cron(verb, rest, flags)
        break
      }
      case 'blog': {
        const { blog } = await import('./commands/blog.js')
        await blog(verb, rest, flags)
        break
      }
      case 'map': {
        const { map } = await import('./commands/map.js')
        await map(verb, rest, flags)
        break
      }
      case 'music': {
        const { music } = await import('./commands/music.js')
        await music(verb, rest, flags)
        break
      }
      case 'capabilities': {
        const { capabilities } = await import('./commands/capabilities.js')
        capabilities(flags)
        break
      }
      case 'schema': {
        const { schema } = await import('./commands/schema.js')
        schema(verb, flags)
        break
      }
      default:
        exitWithError('USAGE', `Unknown command: ${noun}. Run 'con help' for usage.`, flags)
    }
  } catch (err) {
    if (err instanceof HubUnavailableError) {
      exitWithError('HUB_UNAVAILABLE', err.message, flags)
    } else if (err instanceof HubError) {
      exitWithError(err.code, err.message, flags)
    } else if (err instanceof Error) {
      outputError('ERROR', err.message, flags)
      process.exit(EXIT.ERROR)
    } else {
      outputError('ERROR', String(err), flags)
      process.exit(EXIT.ERROR)
    }
  }
}

main()
