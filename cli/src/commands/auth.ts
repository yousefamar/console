import { createInterface } from 'node:readline'
import { hubFetch } from '../client.js'
import { output, exitWithError, info, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function auth(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'login': return authLogin(args, flags)
    case 'logout': return authLogout(args, flags)
    case 'status': return authStatus(flags)
    case 'accounts': return authAccounts(flags)
    default:
      exitWithError('USAGE', `Unknown auth command: ${verb}. Run 'con help auth'.`, flags)
  }
}

async function authLogin(args: string[], flags: GlobalFlags): Promise<void> {
  const provider = args[0]
  if (!provider || !['google', 'matrix'].includes(provider)) {
    exitWithError('USAGE', 'Usage: con auth login <google|matrix>', flags)
  }

  if (provider === 'google') {
    return authLoginGoogle(args.slice(1), flags)
  } else {
    return authLoginMatrix(args.slice(1), flags)
  }
}

async function authLoginGoogle(args: string[], flags: GlobalFlags): Promise<void> {
  // Check if credentials are configured
  const status = await hubFetch<any>('/auth/status')

  if (!status.google?.hasCredentials) {
    // Need to set up credentials first
    if (flags.noInput) {
      exitWithError('AUTH_REQUIRED', 'Google client credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars, or run interactively.', flags)
    }

    info('Google OAuth credentials needed. Get them from https://console.cloud.google.com/apis/credentials')

    const clientId = process.env.GOOGLE_CLIENT_ID || await prompt('Client ID: ')
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || await prompt('Client Secret: ')

    if (!clientId || !clientSecret) {
      exitWithError('USAGE', 'Both client_id and client_secret are required.', flags)
    }

    await hubFetch('/auth/google/credentials', {
      method: 'POST',
      body: { clientId, clientSecret },
    })
    info('Credentials saved.')
  }

  // Open the OAuth flow in browser
  const hubUrl = process.env.CONSOLE_HUB_URL || 'http://localhost:9877'
  const authUrl = `${hubUrl}/auth/google/start`

  info('Opening browser for Google sign-in...')

  // Try to open the browser
  try {
    const { exec } = await import('node:child_process')
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    exec(`${cmd} "${authUrl}"`)
  } catch {
    info(`Please open this URL in your browser:\n  ${authUrl}`)
  }

  // Poll for completion
  info('Waiting for authentication...')
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const poll = await hubFetch<{ done: boolean; email?: string }>('/auth/google/poll')
    if (poll.done) {
      output({ connected: true, email: poll.email }, flags)
      return
    }
  }

  exitWithError('TIMEOUT', 'Authentication timed out. Try again.', flags)
}

async function authLoginMatrix(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)

  let homeserver = opts.homeserver
  let username = opts.username
  let password = opts.password

  if (flags.noInput && (!homeserver || !username || !password)) {
    exitWithError('USAGE', 'In --no-input mode, provide --homeserver, --username, --password', flags)
  }

  if (!homeserver) homeserver = await prompt('Homeserver (e.g. matrix.org): ')
  if (!username) username = await prompt('Username: ')
  if (!password) password = await prompt('Password: ', true)

  if (!homeserver || !username || !password) {
    exitWithError('USAGE', 'All fields are required.', flags)
  }

  const result = await hubFetch<{ userId: string; deviceId: string }>('/auth/matrix/login', {
    method: 'POST',
    body: { homeserver, username, password },
  })

  output({ connected: true, ...result }, flags)
}

async function authLogout(args: string[], flags: GlobalFlags): Promise<void> {
  const provider = args[0]
  if (!provider || !['google', 'matrix'].includes(provider)) {
    exitWithError('USAGE', 'Usage: con auth logout <google|matrix> [--account <email>]', flags)
  }

  const opts = parseFlags(args.slice(1))

  if (provider === 'google') {
    await hubFetch('/auth/logout/google', { method: 'POST', body: { account: opts.account } })
  } else {
    await hubFetch('/auth/logout/matrix', { method: 'POST' })
  }

  output({ disconnected: provider, account: opts.account }, flags)
}

async function authStatus(flags: GlobalFlags): Promise<void> {
  const status = await hubFetch('/auth/status')
  output(status, flags)
}

async function authAccounts(flags: GlobalFlags): Promise<void> {
  const status = await hubFetch<any>('/auth/status')
  const accounts: Array<{ provider: string; email: string; connected: boolean; primary?: boolean }> = []

  if (status.google?.accounts) {
    for (const a of status.google.accounts) {
      accounts.push({ provider: 'google', email: a.email, connected: true, primary: a.isPrimary })
    }
  }

  if (status.matrix?.connected) {
    accounts.push({ provider: 'matrix', email: status.matrix.userId, connected: true })
  }

  if (accounts.length === 0) {
    info('No accounts connected. Run: con auth login google')
  }

  output(accounts, flags)
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    // For hidden input (password), we'd need raw mode but keep it simple
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
