// Auth store — manages OAuth tokens for Google and Matrix
// Persists to ~/.config/console/auth.json (mode 0600)

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
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

export type HubTokenScope = 'cli' | 'al' | 'apk' | 'other'

export interface HubSession {
  id: string
  email: string
  createdAt: number
  lastUsedAt: number
  userAgent?: string
}

export interface HubToken {
  id: string
  name: string
  scope: HubTokenScope
  tokenHash: string
  createdAt: number
  lastUsedAt?: number
  revoked?: true
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
  serpApi?: { apiKey: string }
  /** OwnTracks Recorder (self-hosted location server, e.g. maps.amar.io) */
  owntracks?: { url: string; username: string; password: string }
  /**
   * geocaching.com credentials for the hub-side scraper (pycaching port).
   * Either username+password (CAPTCHA-prone) or a `gspkauth` session cookie.
   */
  geocaching?: { username?: string; password?: string; cookie?: string }
  webhookSecret?: string
  hubAllowedEmails?: string[]
  hubSessions?: HubSession[]
  hubTokens?: HubToken[]
}

const DEFAULT_CONFIG: AuthConfig = {
  google: { clientId: '', clientSecret: '', accounts: [] },
}

const DEFAULT_ALLOWED_EMAILS = ['yousefamar@gmail.com']
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const HUB_TOKEN_BYTES = 32

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, 'hex')
    const bb = Buffer.from(b, 'hex')
    if (ab.length !== bb.length || ab.length === 0) return false
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
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
    // Seed the known OwnTracks server if unconfigured
    if (!this.config.owntracks) {
      this.config.owntracks = {
        url: 'https://maps.amar.io/recorder',
        username: 'amar',
        password: 'bashbash',
      }
      this.save()
    }
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
  // SerpApi (flight data via google_travel_explore / google_flights engines)
  // --------------------------------------------------------------------------

  getSerpApiKey(): string | undefined {
    return this.config.serpApi?.apiKey
  }

  setSerpApiKey(apiKey: string): void {
    this.config.serpApi = { apiKey }
    this.save()
  }

  clearSerpApi(): void {
    this.config.serpApi = undefined
    this.save()
  }

  // --------------------------------------------------------------------------
  // OwnTracks (self-hosted location recorder, proxied by /owntracks/*)
  // --------------------------------------------------------------------------

  getOwntracksConfig(): NonNullable<AuthConfig['owntracks']> | undefined {
    return this.config.owntracks
  }

  setOwntracksConfig(cfg: NonNullable<AuthConfig['owntracks']>): void {
    this.config.owntracks = cfg
    this.save()
  }

  // --------------------------------------------------------------------------
  // Geocaching.com scraper credentials (pycaching port)
  // --------------------------------------------------------------------------

  getGeocachingCreds(): NonNullable<AuthConfig['geocaching']> | undefined {
    return this.config.geocaching
  }

  setGeocachingCreds(creds: NonNullable<AuthConfig['geocaching']>): void {
    // Merge so setting a cookie doesn't wipe a stored username, and vice-versa.
    this.config.geocaching = { ...this.config.geocaching, ...creds }
    this.save()
  }

  clearGeocachingCreds(): void {
    this.config.geocaching = undefined
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
      serpApi: { configured: !!this.config.serpApi?.apiKey },
    }
  }

  // --------------------------------------------------------------------------
  // Hub auth — allow-list, sessions, bearer tokens
  // --------------------------------------------------------------------------

  getHubAllowedEmails(): string[] {
    if (!this.config.hubAllowedEmails || this.config.hubAllowedEmails.length === 0) {
      this.config.hubAllowedEmails = [...DEFAULT_ALLOWED_EMAILS]
      this.save()
    }
    return [...this.config.hubAllowedEmails]
  }

  isHubAllowedEmail(email: string): boolean {
    return this.getHubAllowedEmails().some((e) => e.toLowerCase() === email.toLowerCase())
  }

  addHubAllowedEmail(email: string): void {
    const list = this.getHubAllowedEmails()
    if (!list.some((e) => e.toLowerCase() === email.toLowerCase())) {
      list.push(email)
      this.config.hubAllowedEmails = list
      this.save()
    }
  }

  removeHubAllowedEmail(email: string): void {
    const list = this.getHubAllowedEmails().filter((e) => e.toLowerCase() !== email.toLowerCase())
    this.config.hubAllowedEmails = list
    this.save()
  }

  // Sessions (browser cookie principals)

  createHubSession(email: string, userAgent?: string): HubSession {
    const session: HubSession = {
      id: randomBytes(32).toString('base64url'),
      email,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent,
    }
    const sessions = this.config.hubSessions ?? []
    this.pruneExpiredSessions(sessions)
    sessions.push(session)
    this.config.hubSessions = sessions
    this.save()
    return session
  }

  findHubSession(id: string): HubSession | undefined {
    const sessions = this.config.hubSessions ?? []
    const now = Date.now()
    for (const s of sessions) {
      if (safeEqualHex(sha256Hex(s.id), sha256Hex(id))) {
        if (now - s.createdAt > SESSION_TTL_MS) return undefined
        s.lastUsedAt = now
        // Lazy save — TTL bumps don't need disk hits every request
        return s
      }
    }
    return undefined
  }

  touchHubSession(id: string): void {
    const sessions = this.config.hubSessions ?? []
    const s = sessions.find((x) => x.id === id)
    if (s) {
      s.lastUsedAt = Date.now()
      this.save()
    }
  }

  revokeHubSession(id: string): void {
    const sessions = this.config.hubSessions ?? []
    this.config.hubSessions = sessions.filter((s) => s.id !== id)
    this.save()
  }

  listHubSessions(): Array<Omit<HubSession, 'id'> & { idPrefix: string }> {
    const sessions = this.config.hubSessions ?? []
    return sessions.map(({ id, ...rest }) => ({ ...rest, idPrefix: id.slice(0, 8) }))
  }

  private pruneExpiredSessions(sessions: HubSession[]): void {
    const now = Date.now()
    const keep = sessions.filter((s) => now - s.createdAt <= SESSION_TTL_MS)
    if (keep.length !== sessions.length) {
      sessions.length = 0
      sessions.push(...keep)
    }
  }

  // Bearer tokens (CLI / Al / APK / other)

  createHubToken(name: string, scope: HubTokenScope): { token: HubToken; plaintext: string } {
    const plaintext = randomBytes(HUB_TOKEN_BYTES).toString('base64url')
    const token: HubToken = {
      id: randomBytes(8).toString('base64url'),
      name,
      scope,
      tokenHash: sha256Hex(plaintext),
      createdAt: Date.now(),
    }
    const tokens = this.config.hubTokens ?? []
    tokens.push(token)
    this.config.hubTokens = tokens
    this.save()
    return { token, plaintext }
  }

  /**
   * Validate a presented bearer token. Returns the matching token meta or null.
   * Uses timing-safe comparison.
   */
  validateHubToken(plaintext: string): HubToken | null {
    if (!plaintext) return null
    const incomingHash = sha256Hex(plaintext)
    const tokens = this.config.hubTokens ?? []
    for (const t of tokens) {
      if (t.revoked) continue
      if (safeEqualHex(t.tokenHash, incomingHash)) {
        t.lastUsedAt = Date.now()
        // Persist usage lazily on next save; not critical to flush per-request.
        return t
      }
    }
    return null
  }

  listHubTokens(): Array<Omit<HubToken, 'tokenHash'>> {
    const tokens = this.config.hubTokens ?? []
    return tokens.map(({ tokenHash, ...rest }) => rest)
  }

  revokeHubToken(id: string): boolean {
    const tokens = this.config.hubTokens ?? []
    const t = tokens.find((x) => x.id === id)
    if (!t) return false
    t.revoked = true
    this.save()
    return true
  }

  /**
   * Ensure a single named token for a fixed-scope local consumer exists.
   * Returns the plaintext IFF a new token was just minted; otherwise null
   * (because we never store plaintext — old plaintexts are unrecoverable).
   * Used by the hub on first boot to mint CLI + Al tokens.
   */
  ensureLocalToken(name: string, scope: HubTokenScope): string | null {
    const tokens = this.config.hubTokens ?? []
    const existing = tokens.find((t) => t.scope === scope && t.name === name && !t.revoked)
    if (existing) return null
    const { plaintext } = this.createHubToken(name, scope)
    return plaintext
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
