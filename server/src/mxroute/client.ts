// mxroute Email Hosting API (https://api.mxroute.com, OpenAPI at /openapi.yaml,
// shipped in mxroute 4.0.1). Service-management only — mailboxes, domains,
// forwarders — never mail itself. Every request carries three headers; the
// key is minted at panel.mxroute.com → Advanced → API Keys and lives in
// `~/.config/console/mxroute.env` beside the other secrets.

import { existsSync, readFileSync } from 'node:fs'
import { parseMailEnv } from '../imap/accounts.js'

export interface MxrouteConfig {
  /** `X-Server` — the DirectAdmin server hostname, e.g. `blizzard.mxrouting.net`. */
  server: string
  /** `X-Username` — the DirectAdmin username. */
  username: string
  apiKey: string
  /** Default domain for mailboxes (`amar.io`). */
  domain: string
  baseUrl: string
}

export interface MxrouteEmailAccount {
  username: string
  email: string
  quota: number
  usage: number
  limit: number
  sent: number
  suspended: boolean
}

export class MxrouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message)
  }
}

export function loadMxrouteConfig(file: string): MxrouteConfig | null {
  if (!existsSync(file)) return null
  const kv = parseMailEnv(readFileSync(file, 'utf8'))
  if (!kv.MXROUTE_SERVER || !kv.MXROUTE_USERNAME || !kv.MXROUTE_API_KEY) return null
  return {
    server: kv.MXROUTE_SERVER,
    username: kv.MXROUTE_USERNAME,
    apiKey: kv.MXROUTE_API_KEY,
    domain: kv.MXROUTE_DOMAIN || 'amar.io',
    baseUrl: kv.MXROUTE_API_URL || 'https://api.mxroute.com',
  }
}

export class MxrouteClient {
  constructor(private readonly cfg: MxrouteConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  get domain(): string { return this.cfg.domain }
  get server(): string { return this.cfg.server }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        'X-Server': this.cfg.server,
        'X-Username': this.cfg.username,
        'X-API-Key': this.cfg.apiKey,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let parsed: { success?: boolean; data?: T; error?: { code?: string; message?: string; field?: string } } = {}
    try { parsed = text ? JSON.parse(text) : {} } catch { /* non-JSON body → generic error below */ }
    if (!res.ok || parsed.success === false) {
      const e = parsed.error ?? {}
      throw new MxrouteError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? (text || `HTTP ${res.status}`), e.field)
    }
    return parsed.data as T
  }

  listEmailAccounts(domain = this.cfg.domain): Promise<MxrouteEmailAccount[]> {
    return this.call('GET', `/domains/${encodeURIComponent(domain)}/email-accounts`)
  }

  getEmailAccount(user: string, domain = this.cfg.domain): Promise<MxrouteEmailAccount> {
    return this.call('GET', `/domains/${encodeURIComponent(domain)}/email-accounts/${encodeURIComponent(user)}`)
  }

  /** `quota` in MB (0 = unlimited); `limit` = daily send cap (max 9600). */
  createEmailAccount(input: { username: string; password: string; quota?: number; limit?: number }, domain = this.cfg.domain): Promise<unknown> {
    return this.call('POST', `/domains/${encodeURIComponent(domain)}/email-accounts`, input)
  }

  deleteEmailAccount(user: string, domain = this.cfg.domain): Promise<unknown> {
    return this.call('DELETE', `/domains/${encodeURIComponent(domain)}/email-accounts/${encodeURIComponent(user)}`)
  }
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGIT = '23456789'

/** mxroute wants 8+ chars with upper, lower and a digit. Alphanumeric only so
 *  the value survives the single-quoted `.env` (`_kv` strips outer quotes) and
 *  any shell it is pasted into. */
export function generateMailboxPassword(random: (n: number) => Uint8Array, length = 28): string {
  const all = UPPER + LOWER + DIGIT
  const pick = (alphabet: string, n: number) => Array.from(random(n), (b) => alphabet[b % alphabet.length]!)
  const chars = [...pick(UPPER, 1), ...pick(LOWER, 1), ...pick(DIGIT, 1), ...pick(all, length - 3)]
  const shuffle = random(chars.length)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffle[i]! % (i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}
