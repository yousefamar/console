import { describe, it, expect } from 'vitest'
import { BrowserFetch } from '../property/browser-fetch.js'
import type { PwChromium } from '../property/playwright.js'

/** A fake Chromium whose page answers `fetch` from `responder`, counting launches. */
function fakeChromium(responder: (url: string) => { status: number; text: string }) {
  const state = { launches: 0, closes: 0, gotos: [] as string[], evaluations: 0 }
  const chromium: PwChromium = {
    async launch() {
      state.launches++
      return {
        async newContext() {
          return {
            async newPage() {
              return {
                async goto(url: string) { state.gotos.push(url) },
                async waitForTimeout() {},
                async evaluate(_fn: unknown, arg: unknown) {
                  state.evaluations++
                  const { url } = arg as { url: string }
                  const r = responder(url)
                  return { status: r.status, text: r.text, contentType: 'application/json' } as never
                },
              }
            },
            async cookies() { return [{ name: 'datadome', value: 'x', expires: 0 }] },
          }
        },
        async close() { state.closes++ },
      }
    },
  }
  return { chromium, state }
}

describe('BrowserFetch', () => {
  it('launches once, parks on the origin, and serves fetch-shaped responses in order with the gap', async () => {
    const { chromium, state } = fakeChromium((url) => ({ status: 200, text: JSON.stringify({ url }) }))
    const bf = new BrowserFetch({ origin: 'https://www.immobiliare.it/', log: () => {}, minGapMs: 20, idleMs: 60_000, loadChromium: async () => chromium })
    const t0 = Date.now()
    const [a, b] = await Promise.all([bf.fetch('https://www.immobiliare.it/api-next/a'), bf.fetch(new URL('https://www.immobiliare.it/api-next/b'), { headers: { accept: 'application/json' } })])
    expect(a.ok).toBe(true)
    expect((await a.json()).url).toBe('https://www.immobiliare.it/api-next/a')
    expect((await b.json()).url).toBe('https://www.immobiliare.it/api-next/b')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20)
    expect(state.launches).toBe(1)
    expect(state.gotos).toEqual(['https://www.immobiliare.it/'])
    await bf.close()
    expect(state.closes).toBe(1)
  })

  it('a 403 relaunches once for a fresh cookie; a second 403 is returned to the caller', async () => {
    let calls = 0
    const { chromium, state } = fakeChromium(() => (++calls === 1 ? { status: 403, text: '{"url":"https://geo.captcha-delivery.com/..."}' } : { status: 200, text: '{"count":1}' }))
    const bf = new BrowserFetch({ origin: 'https://www.immobiliare.it/', log: () => {}, minGapMs: 0, loadChromium: async () => chromium })
    const r = await bf.fetch('https://www.immobiliare.it/api-next/x')
    expect(r.status).toBe(200)
    expect(state.launches).toBe(2)
    expect(state.closes).toBe(1)

    const always403 = fakeChromium(() => ({ status: 403, text: '{}' }))
    const bf2 = new BrowserFetch({ origin: 'https://www.immobiliare.it/', log: () => {}, minGapMs: 0, loadChromium: async () => always403.chromium })
    const r2 = await bf2.fetch('https://www.immobiliare.it/api-next/x')
    expect(r2.status).toBe(403)
    expect(always403.state.launches).toBe(2)
    await bf.close()
    await bf2.close()
  })

  it('closes the browser after idleMs and relaunches on the next request', async () => {
    const { chromium, state } = fakeChromium(() => ({ status: 200, text: '{}' }))
    const bf = new BrowserFetch({ origin: 'https://www.immobiliare.it/', log: () => {}, minGapMs: 0, idleMs: 30, loadChromium: async () => chromium })
    await bf.fetch('https://www.immobiliare.it/api-next/x')
    await new Promise((r) => setTimeout(r, 80))
    expect(state.closes).toBe(1)
    await bf.fetch('https://www.immobiliare.it/api-next/y')
    expect(state.launches).toBe(2)
    await bf.close()
  })

  it('no Playwright on the machine → a clear error, not a hang', async () => {
    const bf = new BrowserFetch({ origin: 'https://www.immobiliare.it/', log: () => {}, loadChromium: async () => null })
    await expect(bf.fetch('https://www.immobiliare.it/api-next/x')).rejects.toThrow(/no Playwright install/)
  })
})
