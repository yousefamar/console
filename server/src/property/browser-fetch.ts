// In-browser fetch for DataDome-walled portals (immobiliare, since 2026-09-07).
//
// DataDome fingerprints the TLS handshake as well as the cookie, so a
// `datadome` cookie minted in a browser is worthless to Node's fetch (verified
// 2026-09-13: the same request 200s inside the page and 403s from undici with
// the page's cookies). The request itself has to run inside a page on the
// portal's origin. Playwright's full Chromium in new-headless mode
// (`channel: 'chromium'`) passes the wall; the default headless shell is served
// the captcha even on the homepage, as is curl from the VPS.
//
// One browser, one page, requests serialised and paced. Launched on first use,
// closed after `idleMs` without a request, relaunched on demand; a 403 (the
// captcha JSON) relaunches once for a fresh cookie before giving up.

import { loadChromium, type PwBrowser, type PwPage } from './playwright.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Wait this long for DataDome's script to set its cookie before the first request. */
const COOKIE_WAIT_MS = 10_000

export interface BrowserFetchOptions {
  /** Page the browser parks on — requests run from this origin. */
  origin: string
  log: (msg: string) => void
  locale?: string
  /** Minimum spacing between requests (10 pages at 1.5 s passed; a burst is what a bot manager keys on). */
  minGapMs?: number
  idleMs?: number
  /** Injectable for tests; defaults to the machine's Playwright. */
  loadChromium?: typeof loadChromium
}

export class BrowserFetch {
  private browser: PwBrowser | null = null
  private page: PwPage | null = null
  private opening: Promise<PwPage> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private lastRequestAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly minGapMs: number
  private readonly idleMs: number
  private readonly load: typeof loadChromium

  constructor(private readonly opts: BrowserFetchOptions) {
    this.minGapMs = opts.minGapMs ?? 1000
    this.idleMs = opts.idleMs ?? 2 * 60 * 1000
    this.load = opts.loadChromium ?? loadChromium
  }

  /** Drop-in for `fetch`: same URL/headers in, a `Response` out. */
  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = headersToObject(init?.headers)
    const run = this.queue.then(() => this.request(url, headers))
    this.queue = run.catch(() => undefined)
    return run
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const b = this.browser
    this.browser = null
    this.page = null
    await b?.close().catch(() => {})
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const wait = this.lastRequestAt + this.minGapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    let result = await this.inPage(url, headers)
    if (result.status === 403) {
      // The cookie went stale or the challenge was re-armed: one fresh browser.
      this.opts.log(`[browser-fetch] 403 from ${new URL(url).host} — relaunching for a fresh cookie`)
      await this.close()
      result = await this.inPage(url, headers)
    }
    this.lastRequestAt = Date.now()
    this.armIdle()
    return new Response(result.text, { status: result.status, headers: { 'content-type': result.contentType } })
  }

  private async inPage(url: string, headers: Record<string, string>): Promise<{ status: number; text: string; contentType: string }> {
    const page = await this.ensurePage()
    return page.evaluate(
      async ({ url, headers }) => {
        const r = await fetch(url, { headers, credentials: 'include' })
        return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type') ?? 'application/octet-stream' }
      },
      { url, headers },
    )
  }

  private ensurePage(): Promise<PwPage> {
    if (this.page) return Promise.resolve(this.page)
    if (this.opening) return this.opening
    this.opening = this.open().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async open(): Promise<PwPage> {
    const chromium = await this.load()
    if (!chromium) throw new Error(`no Playwright install found — cannot reach ${new URL(this.opts.origin).host} through the bot wall`)
    const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-blink-features=AutomationControlled'] })
    try {
      const ctx = await browser.newContext({ locale: this.opts.locale ?? 'it-IT', viewport: { width: 1400, height: 900 }, userAgent: UA })
      const page = await ctx.newPage()
      await page.goto(this.opts.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const deadline = Date.now() + COOKIE_WAIT_MS
      while (Date.now() < deadline) {
        if ((await ctx.cookies()).some((c) => c.name === 'datadome')) break
        await page.waitForTimeout(500)
      }
      this.browser = browser
      this.page = page
      this.opts.log(`[browser-fetch] browser up on ${new URL(this.opts.origin).host}`)
      return page
    } catch (e) {
      await browser.close().catch(() => {})
      throw e
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.close().then(() => this.opts.log('[browser-fetch] idle — browser closed'))
    }, this.idleMs)
    this.idleTimer.unref()
  }
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {}
  if (h instanceof Headers) return Object.fromEntries(h.entries())
  if (Array.isArray(h)) return Object.fromEntries(h)
  return { ...h }
}
