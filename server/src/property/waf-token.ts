// AWS WAF token minter for ImmoScout24.
//
// IS24 gates every HTML page behind an AWS WAF JS challenge (HTTP 401,
// "Ich bin kein Roboter"). The challenge self-solves in a real browser and
// mints an `aws-waf-token` cookie with a 4-day TTL, which is then portable to
// plain fetch. So: drive a headless Chromium at the homepage once every few
// days, cache the token on disk, and let the client use it over plain HTTP.
//
// Playwright is NOT a dependency of this repo — it's a big install and only
// this one portal needs it. We resolve it from wherever it already exists on
// the machine and degrade gracefully (IS24 count queries still work without a
// token; only listing reads need one).
//
// Notes: ~/sync/brain/root/projects/home/immoscout24-api.md

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

const HOMEPAGE = 'https://www.immobilienscout24.de/'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Refresh this far before the cookie's own expiry. */
const RENEW_MARGIN_MS = 12 * 60 * 60 * 1000

/** Playwright installs we know about on this machine, most-likely first. */
const PLAYWRIGHT_CANDIDATES = [
  `${homedir()}/proj/code/sainsburys/node_modules/playwright/index.mjs`,
  `${homedir()}/proj/code/astera-app/node_modules/playwright/index.mjs`,
  `${homedir()}/proj/code/reflection-tools/node_modules/playwright/index.mjs`,
]

interface Cached {
  token: string
  expiresAt: number
}

export class WafTokenStore {
  private cache: Cached | null = null
  private inflight: Promise<string | null> | null = null

  constructor(
    private readonly file: string,
    private readonly log: (msg: string) => void,
  ) {}

  /** Cached token if still fresh, else null. Never launches a browser. */
  peek(): string | null {
    this.load()
    if (!this.cache) return null
    if (this.cache.expiresAt - RENEW_MARGIN_MS < Date.now()) return null
    return this.cache.token
  }

  /**
   * A usable token, minting one if needed. Returns null when no browser is
   * available — callers must treat that as "IS24 listing reads unavailable"
   * rather than a hard error.
   */
  async get(): Promise<string | null> {
    const fresh = this.peek()
    if (fresh) return fresh
    // Single-flight: a browser launch is expensive and two concurrent polls
    // would otherwise each spawn one.
    if (this.inflight) return this.inflight
    this.inflight = this.mint().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * Discard the cached token after the WAF rejected it. Observed 2026-08-15: a
   * token can start 401ing days before its own `expires`, so TTL alone is not a
   * validity test — the only reliable signal is a 401 from a real request.
   */
  invalidate(): void {
    this.cache = null
    try {
      rmSync(this.file, { force: true })
    } catch {
      // A stale file only costs us one wasted attempt next boot.
    }
  }

  private async mint(): Promise<string | null> {
    const chromium = await this.loadChromium()
    if (!chromium) {
      this.log('[is24] no Playwright install found — cannot mint a WAF token')
      return null
    }
    let browser: { close(): Promise<void> } | null = null
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      })
      const ctx = await (browser as PwBrowser).newContext({
        locale: 'de-DE',
        viewport: { width: 1400, height: 900 },
        userAgent: UA,
      })
      const page = await ctx.newPage()
      // The first response IS a 401 challenge page — that's expected. The
      // challenge script then runs and replaces the document in ~3s.
      await page.goto(HOMEPAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(2000)
        const cookie = (await ctx.cookies()).find((c) => c.name === 'aws-waf-token')
        if (cookie?.value) {
          const expiresAt = cookie.expires > 0 ? cookie.expires * 1000 : Date.now() + 4 * 24 * 3600 * 1000
          this.cache = { token: cookie.value, expiresAt }
          this.save()
          this.log(`[is24] minted WAF token, expires ${new Date(expiresAt).toISOString()}`)
          return cookie.value
        }
      }
      this.log('[is24] WAF challenge did not yield a token within 30s')
      return null
    } catch (e) {
      this.log(`[is24] WAF token mint failed: ${(e as Error).message}`)
      return null
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  private async loadChromium(): Promise<PwChromium | null> {
    for (const path of PLAYWRIGHT_CANDIDATES) {
      if (!existsSync(path)) continue
      try {
        const mod = (await import(path)) as { chromium?: PwChromium }
        if (mod.chromium) return mod.chromium
      } catch {
        // try the next candidate
      }
    }
    return null
  }

  private load(): void {
    if (this.cache) return
    try {
      if (existsSync(this.file)) {
        this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as Cached
      }
    } catch {
      this.cache = null
    }
  }

  private save(): void {
    if (!this.cache) return
    mkdirSync(dirname(this.file), { recursive: true })
    // Session-ish credential — keep it owner-readable only.
    writeFileSync(this.file, JSON.stringify(this.cache), { encoding: 'utf8', mode: 0o600 })
  }
}

// Minimal structural types for the Playwright bits we touch — we can't import
// its types since it isn't a dependency here.
interface PwChromium {
  launch(opts: { headless: boolean; args?: string[] }): Promise<PwBrowser>
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
}
interface PwContext {
  newPage(): Promise<PwPage>
  cookies(): Promise<Array<{ name: string; value: string; expires: number }>>
}
interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
}
