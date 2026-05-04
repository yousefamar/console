// Cross-origin IndexedDB + localStorage migration via iframe postMessage.
//
// Why: localStorage and IndexedDB are scoped per origin (scheme + host +
// port). The SPA used to live on `:5173` (Vite tailnet); the public Funnel
// URL is `:8443` — a different origin. Without this, switching ports means a
// fresh empty cache and a re-sync from scratch.
//
// How: the destination page spawns a hidden iframe pointed at the source
// origin with `?migrate=1`. The slave detects iframe + flag, awaits the
// parent's `export` postMessage, dumps every IDB table + every localStorage
// key, and posts back. The parent writes everything to its own IDB +
// localStorage. Origin checks on both sides keep this from being a hostile
// bridge.

import { db } from '@/db'

const MIGRATION_PARAM = 'migrate'

const TABLES = [
  'threads',
  'messages',
  'attachmentData',
  'chatRooms',
  'chatMessages',
  'queue',
  'meta',
  'feedItems',
  'feedRead',
  'calendarList',
  'calendarEvents',
] as const

type Tbl = (typeof TABLES)[number]

interface ExportPayload {
  idb: Partial<Record<Tbl, unknown[]>>
  localStorage: Record<string, string>
}

const READY_TYPE = 'console-migrate-ready'
const REQ_TYPE = 'console-migrate-export'
const RES_TYPE = 'console-migrate-export-result'

// localStorage keys we never copy across origins. `console_hub_url` is the
// per-origin override of the hub URL — copying it would break the
// destination's same-origin derivation.
const LS_DENYLIST = new Set(['console_hub_url'])

/**
 * Runs at the very top of `main.tsx`. If we're in an iframe whose URL has
 * `?migrate=1`, install the export handler and skip the rest of app boot.
 * Returns true if the slave was activated (caller should not render the app).
 */
export function maybeRunExportSlave(): boolean {
  if (typeof window === 'undefined' || window === window.parent) return false
  const params = new URLSearchParams(window.location.search)
  if (params.get(MIGRATION_PARAM) !== '1') return false

  window.addEventListener('message', async (ev) => {
    if (!ev.data || ev.data.type !== REQ_TYPE) return
    const replyTo = typeof ev.data.replyTo === 'string' ? ev.data.replyTo : null
    if (!replyTo || ev.origin !== replyTo) return
    const requestId = ev.data.requestId
    try {
      const idb: ExportPayload['idb'] = {}
      for (const t of TABLES) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          idb[t] = await (db as any).table(t).toArray()
        } catch {
          // table might not exist on older schemas — ignore
        }
      }
      const ls: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key) continue
        const value = localStorage.getItem(key)
        if (value !== null) ls[key] = value
      }
      const payload: ExportPayload = { idb, localStorage: ls }
      ;(ev.source as Window).postMessage(
        { type: RES_TYPE, requestId, ok: true, payload },
        { targetOrigin: replyTo } as WindowPostMessageOptions,
      )
    } catch (err) {
      ;(ev.source as Window).postMessage(
        { type: RES_TYPE, requestId, ok: false, error: err instanceof Error ? err.message : String(err) },
        { targetOrigin: replyTo } as WindowPostMessageOptions,
      )
    }
  })

  // Tell the parent we're ready. Use `*` because we don't yet know which
  // origin the parent is — the parent verifies our origin on its end.
  try { window.parent.postMessage({ type: READY_TYPE }, '*') } catch { /* ignore */ }
  return true
}

export interface MigrationResult {
  rows: number
  perTable: Partial<Record<Tbl, number>>
  lsKeys: number
  durationMs: number
}

/**
 * Pulls all IDB tables + localStorage from `sourceOrigin` into the current
 * origin. Spawns a hidden iframe at `${sourceOrigin}/?migrate=1`, awaits the
 * ready handshake, requests the dump, and writes it locally. `bulkPut` means
 * pre-existing rows on the destination get overwritten by the source — fine
 * for the typical "old origin has all the data, new origin is empty" case.
 */
export async function importFromOrigin(sourceOrigin: string): Promise<MigrationResult> {
  if (typeof window === 'undefined') throw new Error('not in browser')
  if (sourceOrigin === window.location.origin) {
    throw new Error('source origin must differ from current origin')
  }
  const start = performance.now()

  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.src = `${sourceOrigin}/?${MIGRATION_PARAM}=1`
  document.body.appendChild(iframe)

  try {
    await waitForMessage(
      (ev) => ev.origin === sourceOrigin && ev.data?.type === READY_TYPE,
      30_000,
      'iframe never signalled ready (origin unreachable?)',
    )

    const requestId = Math.random().toString(36).slice(2)
    iframe.contentWindow?.postMessage(
      { type: REQ_TYPE, requestId, replyTo: window.location.origin },
      sourceOrigin,
    )

    const result = await waitForMessage<{
      type: string
      requestId: string
      ok: boolean
      payload?: ExportPayload
      error?: string
    }>(
      (ev) =>
        ev.origin === sourceOrigin
        && ev.data?.type === RES_TYPE
        && ev.data?.requestId === requestId,
      120_000,
      'export response timed out',
    )

    if (!result.ok || !result.payload) {
      throw new Error(result.error || 'export failed')
    }

    const perTable: MigrationResult['perTable'] = {}
    let rows = 0
    for (const t of TABLES) {
      const data = result.payload.idb[t]
      if (!data || data.length === 0) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).table(t).bulkPut(data)
      perTable[t] = data.length
      rows += data.length
    }

    let lsKeys = 0
    for (const [k, v] of Object.entries(result.payload.localStorage)) {
      if (LS_DENYLIST.has(k)) continue
      localStorage.setItem(k, v)
      lsKeys++
    }

    return { rows, perTable, lsKeys, durationMs: Math.round(performance.now() - start) }
  } finally {
    iframe.remove()
  }
}

function waitForMessage<T = unknown>(
  match: (ev: MessageEvent) => boolean,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error(timeoutMessage))
    }, timeoutMs)
    function handler(ev: MessageEvent) {
      if (!match(ev)) return
      clearTimeout(timer)
      window.removeEventListener('message', handler)
      resolve(ev.data as T)
    }
    window.addEventListener('message', handler)
  })
}
