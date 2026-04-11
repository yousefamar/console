// Auth store — manages OAuth tokens for Google and Matrix
// Persists to ~/.config/console/auth.json (mode 0600)

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const AUTH_FILE = join(CONFIG_DIR, 'auth.json')

export interface GoogleAccount {
  email: string
  refreshToken: string
  accessToken?: string
  accessTokenExpiry?: number
  scopes: string[]
  isPrimary?: boolean
}

export interface MonzoAuth {
  clientId: string
  clientSecret: string
  accessToken?: string
  refreshToken?: string
  accessTokenExpiry?: number
  accountId?: string
  userId?: string
}

export interface AuthConfig {
  google: {
    clientId: string
    clientSecret: string
    accounts: GoogleAccount[]
  }
  matrix?: {
    homeserver: string
    userId: string
    deviceId: string
    accessToken: string
  }
  monzo?: MonzoAuth
  webhookSecret?: string
}

const DEFAULT_CONFIG: AuthConfig = {
  google: { clientId: '', clientSecret: '', accounts: [] },
}

export class AuthStore {
  private config: AuthConfig
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() {
    this.config = this.load()
    // Schedule token refreshes for all accounts with existing tokens
    for (const account of this.config.google.accounts) {
      if (account.accessTokenExpiry) {
        this.scheduleRefresh(account.email)
      }
    }
    // Schedule Monzo refresh if configured
    if (this.config.monzo?.accessTokenExpiry) {
      this.scheduleMonzoRefresh()
    }
    // Ensure webhook secret exists
    this.getWebhookSecret()
  }

  // --------------------------------------------------------------------------
  // Config persistence
  // --------------------------------------------------------------------------

  private load(): AuthConfig {
    try {
      if (existsSync(AUTH_FILE)) {
        return JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as AuthConfig
      }
    } catch {
      // Corrupted file — start fresh
    }
    return { ...DEFAULT_CONFIG }
  }

  private save(): void {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(AUTH_FILE, JSON.stringify(this.config, null, 2), 'utf8')
    try {
      chmodSync(AUTH_FILE, 0o600)
    } catch {
      // chmod may fail on some platforms
    }
  }

  // --------------------------------------------------------------------------
  // Google OAuth
  // --------------------------------------------------------------------------

  getGoogleClientId(): string { return this.config.google.clientId }
  getGoogleClientSecret(): string { return this.config.google.clientSecret }

  setGoogleCredentials(clientId: string, clientSecret: string): void {
    this.config.google.clientId = clientId
    this.config.google.clientSecret = clientSecret
    this.save()
  }

  getGoogleAccounts(): GoogleAccount[] {
    return this.config.google.accounts
  }

  getPrimaryGoogleAccount(): GoogleAccount | undefined {
    return this.config.google.accounts.find((a) => a.isPrimary) || this.config.google.accounts[0]
  }

  getGoogleAccount(email: string): GoogleAccount | undefined {
    return this.config.google.accounts.find((a) => a.email === email)
  }

  addGoogleAccount(account: GoogleAccount): void {
    const existing = this.config.google.accounts.findIndex((a) => a.email === account.email)
    if (existing >= 0) {
      this.config.google.accounts[existing] = account
    } else {
      // First account is primary
      if (this.config.google.accounts.length === 0) account.isPrimary = true
      this.config.google.accounts.push(account)
    }
    this.save()
    this.scheduleRefresh(account.email)
  }

  removeGoogleAccount(email: string): void {
    this.config.google.accounts = this.config.google.accounts.filter((a) => a.email !== email)
    const timer = this.refreshTimers.get(email)
    if (timer) {
      clearTimeout(timer)
      this.refreshTimers.delete(email)
    }
    this.save()
  }

  /**
   * Get a valid access token for a Google account.
   * Refreshes automatically if expired or about to expire.
   */
  async getGoogleToken(email?: string): Promise<string | null> {
    const account = email ? this.getGoogleAccount(email) : this.getPrimaryGoogleAccount()
    if (!account) return null

    // Check if token is still valid (with 5 min buffer)
    if (account.accessToken && account.accessTokenExpiry) {
      if (Date.now() < account.accessTokenExpiry - 5 * 60 * 1000) {
        return account.accessToken
      }
    }

    // Refresh the token
    const refreshed = await this.refreshGoogleToken(account.email)
    return refreshed ? account.accessToken! : null
  }

  async refreshGoogleToken(email: string): Promise<boolean> {
    const account = this.getGoogleAccount(email)
    if (!account?.refreshToken) return false

    const clientId = this.config.google.clientId
    const clientSecret = this.config.google.clientSecret
    if (!clientId || !clientSecret) return false

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: account.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error(`[auth] Token refresh failed for ${email}: ${res.status} ${text}`)
        return false
      }

      const data = await res.json() as { access_token: string; expires_in: number }
      account.accessToken = data.access_token
      account.accessTokenExpiry = Date.now() + data.expires_in * 1000
      this.save()
      this.scheduleRefresh(email)
      return true
    } catch (err) {
      console.error(`[auth] Token refresh error for ${email}:`, err)
      return false
    }
  }

  private scheduleRefresh(email: string): void {
    const account = this.getGoogleAccount(email)
    if (!account?.accessTokenExpiry) return

    const timer = this.refreshTimers.get(email)
    if (timer) clearTimeout(timer)

    // Refresh 5 minutes before expiry
    const delay = Math.max(account.accessTokenExpiry - Date.now() - 5 * 60 * 1000, 10000)
    this.refreshTimers.set(email, setTimeout(() => {
      this.refreshGoogleToken(email)
    }, delay))
  }

  /**
   * Exchange an authorization code for tokens.
   * Called from the OAuth callback.
   */
  async exchangeGoogleCode(code: string, redirectUri: string): Promise<{ email: string; account: GoogleAccount }> {
    const clientId = this.config.google.clientId
    const clientSecret = this.config.google.clientSecret

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenRes.ok) {
      const text = await tokenRes.text()
      throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`)
    }

    const tokenData = await tokenRes.json() as {
      access_token: string
      refresh_token: string
      expires_in: number
      scope: string
    }

    // Discover the user's email via Gmail profile (doesn't require openid scope)
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const profile = await profileRes.json() as { emailAddress: string }

    const account: GoogleAccount = {
      email: profile.emailAddress,
      refreshToken: tokenData.refresh_token,
      accessToken: tokenData.access_token,
      accessTokenExpiry: Date.now() + tokenData.expires_in * 1000,
      scopes: tokenData.scope.split(' '),
    }

    this.addGoogleAccount(account)
    return { email: profile.emailAddress, account }
  }

  // --------------------------------------------------------------------------
  // Matrix
  // --------------------------------------------------------------------------

  getMatrixConfig() {
    return this.config.matrix
  }

  setMatrixConfig(config: NonNullable<AuthConfig['matrix']>): void {
    this.config.matrix = config
    this.save()
  }

  clearMatrixConfig(): void {
    this.config.matrix = undefined
    this.save()
  }

  // --------------------------------------------------------------------------
  // Monzo
  // --------------------------------------------------------------------------

  private monzoRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private monzoRefreshing = false

  getMonzoConfig(): MonzoAuth | undefined {
    return this.config.monzo
  }

  setMonzoCredentials(clientId: string, clientSecret: string): void {
    this.config.monzo = { ...this.config.monzo, clientId, clientSecret } as MonzoAuth
    this.save()
  }

  async getMonzoToken(): Promise<string | null> {
    const monzo = this.config.monzo
    if (!monzo?.accessToken) return null

    // Check if token is still valid (with 5 min buffer)
    if (monzo.accessTokenExpiry && Date.now() < monzo.accessTokenExpiry - 5 * 60 * 1000) {
      return monzo.accessToken
    }

    // Refresh the token
    const refreshed = await this.refreshMonzoToken()
    return refreshed ? this.config.monzo!.accessToken! : null
  }

  /**
   * Refresh Monzo token. CRITICAL: Monzo refresh tokens are single-use.
   * The new refresh token must be saved to disk BEFORE anything else.
   */
  async refreshMonzoToken(): Promise<boolean> {
    if (this.monzoRefreshing) {
      // Wait for ongoing refresh
      await new Promise((r) => setTimeout(r, 1000))
      return !!this.config.monzo?.accessToken
    }
    this.monzoRefreshing = true

    const monzo = this.config.monzo
    if (!monzo?.refreshToken || !monzo.clientId || !monzo.clientSecret) {
      this.monzoRefreshing = false
      return false
    }

    try {
      const res = await fetch('https://api.monzo.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: monzo.clientId,
          client_secret: monzo.clientSecret,
          refresh_token: monzo.refreshToken,
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        console.error(`[auth] Monzo token refresh failed: ${res.status} ${text}`)
        // If refresh token is invalid, clear auth (user must re-auth)
        if (res.status === 401 || res.status === 400) {
          monzo.accessToken = undefined
          monzo.refreshToken = undefined
          monzo.accessTokenExpiry = undefined
          this.save()
        }
        return false
      }

      const data = await res.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
        token_type: string
        user_id: string
      }

      // ATOMIC: save new single-use refresh token to disk FIRST
      monzo.refreshToken = data.refresh_token
      monzo.accessToken = data.access_token
      monzo.accessTokenExpiry = Date.now() + data.expires_in * 1000
      monzo.userId = data.user_id
      this.save()

      this.scheduleMonzoRefresh()
      return true
    } catch (err) {
      console.error('[auth] Monzo token refresh error:', err)
      return false
    } finally {
      this.monzoRefreshing = false
    }
  }

  /**
   * Exchange a Monzo authorization code for tokens.
   */
  async exchangeMonzoCode(code: string, redirectUri: string): Promise<void> {
    const monzo = this.config.monzo
    if (!monzo?.clientId || !monzo?.clientSecret) {
      throw new Error('Monzo credentials not configured')
    }

    const res = await fetch('https://api.monzo.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: monzo.clientId,
        client_secret: monzo.clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Monzo token exchange failed: ${res.status} ${text}`)
    }

    const data = await res.json() as {
      access_token: string
      refresh_token: string
      expires_in: number
      token_type: string
      user_id: string
    }

    monzo.accessToken = data.access_token
    monzo.refreshToken = data.refresh_token
    monzo.accessTokenExpiry = Date.now() + data.expires_in * 1000
    monzo.userId = data.user_id
    this.save()

    this.scheduleMonzoRefresh()
  }

  private scheduleMonzoRefresh(): void {
    if (this.monzoRefreshTimer) clearTimeout(this.monzoRefreshTimer)
    const monzo = this.config.monzo
    if (!monzo?.accessTokenExpiry) return

    // Refresh 5 minutes before expiry (tokens last 6 hours)
    const delay = Math.max(monzo.accessTokenExpiry - Date.now() - 5 * 60 * 1000, 10000)
    this.monzoRefreshTimer = setTimeout(() => {
      this.refreshMonzoToken()
    }, delay)
  }

  setMonzoAccountId(accountId: string): void {
    if (this.config.monzo) {
      this.config.monzo.accountId = accountId
      this.save()
    }
  }

  clearMonzo(): void {
    if (this.monzoRefreshTimer) {
      clearTimeout(this.monzoRefreshTimer)
      this.monzoRefreshTimer = null
    }
    this.config.monzo = undefined
    this.save()
  }

  // --------------------------------------------------------------------------
  // Webhook secret
  // --------------------------------------------------------------------------

  getWebhookSecret(): string {
    if (!this.config.webhookSecret) {
      this.config.webhookSecret = randomBytes(16).toString('hex')
      this.save()
    }
    return this.config.webhookSecret
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  getStatus() {
    const monzo = this.config.monzo
    return {
      google: {
        connected: this.config.google.accounts.length > 0,
        hasCredentials: !!(this.config.google.clientId && this.config.google.clientSecret),
        accounts: this.config.google.accounts.map((a) => ({
          email: a.email,
          isPrimary: a.isPrimary ?? false,
          hasToken: !!a.accessToken,
          tokenExpiry: a.accessTokenExpiry ? new Date(a.accessTokenExpiry).toISOString() : null,
        })),
      },
      matrix: this.config.matrix
        ? { connected: true, userId: this.config.matrix.userId, homeserver: this.config.matrix.homeserver }
        : { connected: false },
      monzo: monzo
        ? {
            connected: !!monzo.accessToken,
            hasCredentials: !!(monzo.clientId && monzo.clientSecret),
            hasToken: !!monzo.accessToken,
            accountId: monzo.accountId ?? null,
            tokenExpiry: monzo.accessTokenExpiry ? new Date(monzo.accessTokenExpiry).toISOString() : null,
          }
        : { connected: false, hasCredentials: false },
    }
  }

  destroy(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer)
    }
    this.refreshTimers.clear()
    if (this.monzoRefreshTimer) {
      clearTimeout(this.monzoRefreshTimer)
      this.monzoRefreshTimer = null
    }
  }
}
