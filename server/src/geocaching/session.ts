// geocaching.com HTTP session — cookie jar + login.
//
// We talk to gc.com as Yousef himself (the c:geo / pycaching model). Node's
// `fetch` has no cookie jar, so this class is one: it persists cookies to disk
// (mode 0600), re-sends them on every request, and follows redirects MANUALLY so
// cookies set mid-redirect (e.g. `gspkauth` on the post-login 302) are captured
// — a plain `redirect: 'follow'` would drop them.
//
// Login is CSRF-token + form-POST. gc.com sometimes throws a reCAPTCHA at
// programmatic login; when it does we surface CaptchaRequiredError and the user
// falls back to pasting their browser `gspkauth` cookie (loginWithCookie).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseHTML } from 'linkedom'

const BASE = 'https://www.geocaching.com'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export class TooManyRequestsError extends Error {
  constructor(public resetSeconds: number) {
    super(`geocaching.com rate-limited (429); resets in ${resetSeconds}s`)
    this.name = 'TooManyRequestsError'
  }
}
export class LoginFailedError extends Error {
  constructor(msg = 'geocaching.com login failed (bad credentials?)') {
    super(msg)
    this.name = 'LoginFailedError'
  }
}
export class CaptchaRequiredError extends Error {
  constructor() {
    super('geocaching.com demanded a CAPTCHA. Paste your browser `gspkauth` cookie instead.')
    this.name = 'CaptchaRequiredError'
  }
}

interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
}

export class GeocachingSession {
  private cookies = new Map<string, string>()
  private loggedUser: string | null = null

  constructor(private jarFile: string) {
    this.loadJar()
  }

  get username(): string | null {
    return this.loggedUser
  }

  isLoggedIn(): boolean {
    return this.loggedUser !== null
  }

  // --- low-level HTTP with a cookie jar + manual redirect following ----------

  async request(pathOrUrl: string, opts: RequestOptions = {}, maxRedirects = 5): Promise<Response> {
    let url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl
    let method = opts.method ?? 'GET'
    let body = opts.body

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'en-GB,en;q=0.9',
        ...(opts.headers ?? {}),
      }
      const cookie = this.cookieHeader()
      if (cookie) headers.Cookie = cookie

      const res = await fetch(url, { method, headers, body, redirect: 'manual' })
      this.ingestSetCookies(res)

      if (res.status === 429) {
        throw new TooManyRequestsError(parseInt(res.headers.get('x-rate-limit-reset') ?? '0', 10) || 0)
      }

      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString()
        // Per fetch semantics: 303, and 301/302 on POST, become GET with no body.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
        }
        // drain the redirect body so the socket frees
        await res.arrayBuffer().catch(() => {})
        continue
      }
      return res
    }
    throw new Error('geocaching.com: too many redirects')
  }

  async requestText(pathOrUrl: string, opts?: RequestOptions): Promise<string> {
    const res = await this.request(pathOrUrl, opts)
    return res.text()
  }

  async requestJson<T = unknown>(pathOrUrl: string, opts?: RequestOptions): Promise<T> {
    const res = await this.request(pathOrUrl, {
      ...opts,
      headers: { Accept: 'application/json', ...(opts?.headers ?? {}) },
    })
    return res.json() as Promise<T>
  }

  // --- login -----------------------------------------------------------------

  async login(username: string, password: string): Promise<string> {
    const page = await this.requestText('/account/signin', { headers: { Accept: 'text/html' } })
    const token = extractVerificationToken(page)
    if (!token) throw new LoginFailedError('could not find the sign-in CSRF token')

    const body = new URLSearchParams({
      UsernameOrEmail: username,
      Password: password,
      __RequestVerificationToken: token,
    })
    const res = await this.request('/account/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body,
    })
    const html = await res.text()
    if (/g-recaptcha|recaptcha\//i.test(html)) throw new CaptchaRequiredError()

    const user = getLoggedUser(html) ?? (await this.verify())
    if (!user) throw new LoginFailedError()
    this.loggedUser = user
    this.saveJar()
    return user
  }

  /** Fallback: caller pastes a `gspkauth` cookie from a real browser session. */
  async loginWithCookie(gspkauth: string): Promise<string> {
    this.cookies.set('gspkauth', gspkauth.trim())
    const user = await this.verify()
    if (!user) throw new LoginFailedError('the supplied gspkauth cookie is not valid')
    this.saveJar()
    return user
  }

  /** Hit a logged-in page and read the username out of its inline JS. */
  async verify(): Promise<string | null> {
    const html = await this.requestText('/play', { headers: { Accept: 'text/html' } })
    this.loggedUser = getLoggedUser(html)
    if (this.loggedUser) this.saveJar()
    return this.loggedUser
  }

  // --- cookie jar persistence -------------------------------------------------

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private ingestSetCookies(res: Response): void {
    const h = res.headers as Headers & { getSetCookie?: () => string[] }
    const list = typeof h.getSetCookie === 'function'
      ? h.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : []
    for (const sc of list) {
      const first = sc.split(';', 1)[0]
      const eq = first.indexOf('=')
      if (eq < 0) continue
      const name = first.slice(0, eq).trim()
      const value = first.slice(eq + 1).trim()
      if (!name) continue
      if (!value) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  private loadJar(): void {
    try {
      if (existsSync(this.jarFile)) {
        const data = JSON.parse(readFileSync(this.jarFile, 'utf8')) as {
          cookies?: Record<string, string>
          user?: string | null
        }
        if (data.cookies) for (const [k, v] of Object.entries(data.cookies)) this.cookies.set(k, v)
        this.loggedUser = data.user ?? null
      }
    } catch {
      // corrupt jar — start clean
    }
  }

  private saveJar(): void {
    mkdirSync(dirname(this.jarFile), { recursive: true })
    const tmp = `${this.jarFile}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ cookies: Object.fromEntries(this.cookies), user: this.loggedUser }),
      'utf8',
    )
    renameSync(tmp, this.jarFile)
    try {
      chmodSync(this.jarFile, 0o600)
    } catch {
      // best-effort
    }
  }
}

export function extractVerificationToken(html: string): string | null {
  try {
    const { document } = parseHTML(html)
    const input = document.querySelector('input[name="__RequestVerificationToken"]')
    const val = input?.getAttribute('value')
    if (val) return val
  } catch {
    // fall through to regex
  }
  const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="__RequestVerificationToken"/.exec(
    html,
  )
  return m ? m[1] ?? m[2] ?? null : null
}

export function getLoggedUser(html: string): string | null {
  const m = /"username"\s*:\s*"([^"]+)"/.exec(html)
  return m ? m[1] : null
}
