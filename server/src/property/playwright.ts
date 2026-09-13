// Playwright is NOT a dependency of this repo — it's a big install and only the
// bot-walled portals need it (IS24's WAF token, immobiliare's DataDome wall).
// Resolve it from wherever it already exists on the machine; callers degrade
// gracefully when nothing is found.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

/** Playwright installs we know about on this machine, most-likely first. */
const PLAYWRIGHT_CANDIDATES = [
  `${homedir()}/proj/code/sainsburys/node_modules/playwright/index.mjs`,
  `${homedir()}/proj/code/astera-app/node_modules/playwright/index.mjs`,
  `${homedir()}/proj/code/reflection-tools/node_modules/playwright/index.mjs`,
]

export async function loadChromium(): Promise<PwChromium | null> {
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

// Minimal structural types for the Playwright bits we touch — we can't import
// its types since it isn't a dependency here.
export interface PwChromium {
  launch(opts: { headless: boolean; channel?: string; args?: string[] }): Promise<PwBrowser>
}
export interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
}
export interface PwContext {
  newPage(): Promise<PwPage>
  cookies(): Promise<Array<{ name: string; value: string; expires: number }>>
}
export interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  evaluate<T, A>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T>
}
