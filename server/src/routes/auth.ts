// Auth routes — Google OAuth callback flow + Matrix login + status

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore } from '../auth-store.js'

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/calendar',
].join(' ')

// Track pending OAuth flows
let pendingOAuthState: string | null = null
let lastOAuthResult: { email: string } | null = null

export function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  authStore: AuthStore,
  readBody: (req: IncomingMessage) => Promise<string>,
  hubPort: number,
): boolean {
  // GET /auth/status
  if (path === '/auth/status' && req.method === 'GET') {
    const status = authStore.getStatus()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status))
    return true
  }

  // GET /auth/google/start — initiate OAuth flow
  if (path === '/auth/google/start' && req.method === 'GET') {
    const clientId = authStore.getGoogleClientId()
    if (!clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Google client_id not configured. Run: con auth login google' }))
      return true
    }

    // Generate state for CSRF protection
    pendingOAuthState = Math.random().toString(36).slice(2)
    lastOAuthResult = null

    const redirectUri = `http://localhost:${hubPort}/auth/google/callback`
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', GOOGLE_SCOPES)
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', pendingOAuthState)

    // Redirect the browser to Google's consent page
    res.writeHead(302, { Location: url.toString() })
    res.end()
    return true
  }

  // GET /auth/google/callback — OAuth redirect callback
  if (path.startsWith('/auth/google/callback') && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://localhost:${hubPort}`)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body><h2>Authentication failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`)
      return true
    }

    if (!code || state !== pendingOAuthState) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Invalid OAuth callback</h2><p>State mismatch or missing code.</p></body></html>')
      return true
    }

    pendingOAuthState = null

    const redirectUri = `http://localhost:${hubPort}/auth/google/callback`
    authStore.exchangeGoogleCode(code, redirectUri)
      .then(({ email }) => {
        lastOAuthResult = { email }
        console.log(`[auth] Google account connected: ${email}`)
      })
      .catch((err: Error) => {
        console.error('[auth] OAuth exchange failed:', err.message)
      })

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`
      <html><body style="font-family: system-ui; text-align: center; padding-top: 100px;">
        <h2>✓ Connected to Google</h2>
        <p>You can close this tab and return to the CLI.</p>
      </body></html>
    `)
    return true
  }

  // GET /auth/google/poll — CLI polls this to check if OAuth completed
  if (path === '/auth/google/poll' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (lastOAuthResult) {
      const result = lastOAuthResult
      lastOAuthResult = null
      res.end(JSON.stringify({ done: true, email: result.email }))
    } else {
      res.end(JSON.stringify({ done: false }))
    }
    return true
  }

  // POST /auth/google/credentials — set client_id and client_secret
  if (path === '/auth/google/credentials' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { clientId, clientSecret } = JSON.parse(body) as { clientId: string; clientSecret: string }
      authStore.setGoogleCredentials(clientId, clientSecret)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }).catch((err: Error) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    })
    return true
  }

  // POST /auth/matrix/login
  if (path === '/auth/matrix/login' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { homeserver, username, password } = JSON.parse(body) as {
        homeserver: string; username: string; password: string
      }

      // Normalize homeserver URL
      let hs = homeserver
      if (!hs.startsWith('http')) hs = `https://${hs}`
      hs = hs.replace(/\/$/, '')

      // Try .well-known discovery
      try {
        const wellKnown = await fetch(`${hs}/.well-known/matrix/client`)
        if (wellKnown.ok) {
          const data = await wellKnown.json() as { 'm.homeserver'?: { base_url: string } }
          if (data['m.homeserver']?.base_url) {
            hs = data['m.homeserver'].base_url.replace(/\/$/, '')
          }
        }
      } catch { /* ignore well-known failures */ }

      // Login
      const loginRes = await fetch(`${hs}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
          initial_device_display_name: 'Console Hub',
        }),
      })

      if (!loginRes.ok) {
        const text = await loginRes.text()
        res.writeHead(loginRes.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Matrix login failed: ${text}` }))
        return
      }

      const loginData = await loginRes.json() as {
        user_id: string; access_token: string; device_id: string
      }

      authStore.setMatrixConfig({
        homeserver: hs,
        userId: loginData.user_id,
        deviceId: loginData.device_id,
        accessToken: loginData.access_token,
      })

      console.log(`[auth] Matrix connected: ${loginData.user_id} on ${hs}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ userId: loginData.user_id, deviceId: loginData.device_id }))
    }).catch((err: Error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    })
    return true
  }

  // POST /auth/logout/google
  if (path === '/auth/logout/google' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { account } = JSON.parse(body || '{}') as { account?: string }
      if (account) {
        authStore.removeGoogleAccount(account)
      } else {
        // Remove all
        for (const a of authStore.getGoogleAccounts()) {
          authStore.removeGoogleAccount(a.email)
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }).catch((err: Error) => {
      res.writeHead(400)
      res.end(JSON.stringify({ error: err.message }))
    })
    return true
  }

  // POST /auth/logout/matrix
  if (path === '/auth/logout/matrix' && req.method === 'POST') {
    authStore.clearMatrixConfig()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  return false
}
