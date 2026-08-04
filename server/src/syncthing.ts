// Syncthing propagation detection.
//
// The vault (~/sync/brain/root) is NOT git-pushed — it reaches the VPS purely
// via Syncthing. So "publish a blog post" has a hidden race: the hub writes
// log/<ts>.md locally and used to GET /rebuild immediately, before Syncthing
// carried the file to the VPS. Eleventy then built WITHOUT the post and nothing
// re-triggered a build when the file finally landed → the post sat undeployed
// until a manual re-publish.
//
// This module talks to the LOCAL Syncthing REST API to (1) force an immediate
// scan of a just-written path and (2) wait until it has fully propagated to the
// remote(s) the folder shares with, so the caller can trigger the rebuild only
// once the VPS actually has the file.
//
// Credentials are read from the local Syncthing config at runtime (never
// hardcoded): the <apikey> and <gui><address> from config.xml. Everything else
// (folders, device ids, local id) comes from the REST API.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

interface SyncthingConn {
  apiKey: string
  baseUrl: string
}

interface StFolder {
  id: string
  path: string
  devices: Array<{ deviceID: string }>
}

interface Completion {
  completion: number
  needBytes: number
  needItems: number
  needDeletes: number
  remoteState?: string
}

export interface VaultSyncStatus {
  /** false when Syncthing is unreachable / unconfigured — caller degrades gracefully. */
  available: boolean
  folderId?: string
  /** Remote device ids the folder shares with (local id excluded). */
  remotes?: string[]
  /** true when every remote has needItems===0 && needBytes===0 && needDeletes===0. */
  synced?: boolean
  perRemote?: Record<string, Completion>
  error?: string
}

export interface WaitResult extends VaultSyncStatus {
  waitedMs: number
  timedOut: boolean
}

const CONFIG_CANDIDATES = [
  join(homedir(), '.local/state/syncthing/config.xml'),
  join(homedir(), '.config/syncthing/config.xml'),
]

let cachedConn: SyncthingConn | null | undefined
let cachedLocalId: string | undefined

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** Read apikey + gui address from config.xml (or env overrides). Cached; a
 *  missing config yields null so callers no-op cleanly. */
function readConn(): SyncthingConn | null {
  if (cachedConn !== undefined) return cachedConn

  const envKey = process.env.SYNCTHING_API_KEY
  const envUrl = process.env.SYNCTHING_URL
  if (envKey) {
    cachedConn = { apiKey: envKey, baseUrl: (envUrl ?? 'http://127.0.0.1:8384').replace(/\/$/, '') }
    return cachedConn
  }

  const path = CONFIG_CANDIDATES.find((p) => existsSync(p))
  if (!path) { cachedConn = null; return null }
  try {
    const xml = readFileSync(path, 'utf-8')
    const apiKey = /<apikey>([^<]+)<\/apikey>/.exec(xml)?.[1]?.trim()
    if (!apiKey) { cachedConn = null; return null }
    // <gui ...><address>host:port</address> — grab the address inside <gui>.
    const guiBlock = /<gui\b[\s\S]*?<\/gui>/.exec(xml)?.[0] ?? xml
    const tls = /<gui\b[^>]*\btls="true"/.test(guiBlock)
    const addr = /<address>([^<]+)<\/address>/.exec(guiBlock)?.[1]?.trim() ?? '127.0.0.1:8384'
    const baseUrl = envUrl?.replace(/\/$/, '') ?? `${tls ? 'https' : 'http'}://${addr}`
    cachedConn = { apiKey, baseUrl }
    return cachedConn
  } catch {
    cachedConn = null
    return null
  }
}

async function stGet<T>(conn: SyncthingConn, apiPath: string): Promise<T> {
  const res = await fetch(`${conn.baseUrl}${apiPath}`, {
    headers: { 'X-API-Key': conn.apiKey },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`syncthing ${apiPath} → HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function localDeviceId(conn: SyncthingConn): Promise<string> {
  if (cachedLocalId) return cachedLocalId
  const status = await stGet<{ myID: string }>(conn, '/rest/system/status')
  cachedLocalId = status.myID
  return cachedLocalId
}

/** Find the Syncthing folder whose path contains `absPath` (deepest match). */
async function folderForPath(conn: SyncthingConn, absPath: string): Promise<StFolder | null> {
  const folders = await stGet<StFolder[]>(conn, '/rest/config/folders')
  const target = resolve(absPath)
  let best: StFolder | null = null
  let bestLen = -1
  for (const f of folders) {
    const fp = resolve(expandTilde(f.path))
    const withSep = fp.endsWith(sep) ? fp : fp + sep
    if ((target === fp || target.startsWith(withSep)) && fp.length > bestLen) {
      best = f
      bestLen = fp.length
    }
  }
  return best
}

/** Force an immediate rescan of a sub-path so a just-written file is indexed
 *  now, not after the fsWatcher debounce (fsWatcherDelayS=10). Best-effort. */
export async function scanVaultPath(absPath: string): Promise<void> {
  const conn = readConn()
  if (!conn) return
  try {
    const folder = await folderForPath(conn, absPath)
    if (!folder) return
    const folderRoot = resolve(expandTilde(folder.path))
    const target = resolve(absPath)
    let sub = target.slice(folderRoot.length)
    sub = sub.replace(new RegExp(`^\\${sep}`), '') // strip leading separator
    const qs = new URLSearchParams({ folder: folder.id, next: '0' })
    if (sub) qs.set('sub', sub)
    await fetch(`${conn.baseUrl}/rest/db/scan?${qs.toString()}`, {
      method: 'POST',
      headers: { 'X-API-Key': conn.apiKey },
      signal: AbortSignal.timeout(8000),
    })
  } catch { /* best effort — a failed scan just means we wait for the debounce */ }
}

/** One-shot propagation snapshot for the folder containing `absPath`. */
export async function getVaultSyncStatus(absPath: string): Promise<VaultSyncStatus> {
  const conn = readConn()
  if (!conn) return { available: false, error: 'syncthing not configured' }
  try {
    const [folder, localId] = await Promise.all([folderForPath(conn, absPath), localDeviceId(conn)])
    if (!folder) return { available: false, error: `no syncthing folder for ${absPath}` }
    const remotes = folder.devices.map((d) => d.deviceID).filter((id) => id && id !== localId)
    if (remotes.length === 0) return { available: true, folderId: folder.id, remotes: [], synced: true, perRemote: {} }

    const perRemote: Record<string, Completion> = {}
    await Promise.all(remotes.map(async (device) => {
      perRemote[device] = await stGet<Completion>(
        conn,
        `/rest/db/completion?folder=${encodeURIComponent(folder.id)}&device=${encodeURIComponent(device)}`,
      )
    }))
    const synced = remotes.every((d) => {
      const c = perRemote[d]!
      return c.needItems === 0 && c.needBytes === 0 && c.needDeletes === 0
    })
    return { available: true, folderId: folder.id, remotes, synced, perRemote }
  } catch (e) {
    return { available: false, error: (e as Error).message }
  }
}

export interface WaitOpts {
  /** Give up after this long and let the caller proceed anyway. Default 60s. */
  timeoutMs?: number
  /** Poll cadence. Default 1s. */
  pollMs?: number
  /** Force-scan the path first so the write is indexed immediately. Default true. */
  scan?: boolean
}

/** Wait until `absPath`'s folder is fully propagated to every remote (or the
 *  timeout elapses). Never throws — a Syncthing that's down/unreachable resolves
 *  with `available:false` so the caller still triggers the rebuild. */
export async function waitForVaultSync(absPath: string, opts: WaitOpts = {}): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const pollMs = opts.pollMs ?? 1000
  const scan = opts.scan ?? true
  const start = Date.now()

  if (scan) await scanVaultPath(absPath)

  let last: VaultSyncStatus = { available: false }
  while (true) {
    last = await getVaultSyncStatus(absPath)
    // If Syncthing is unreachable there's nothing to wait for — proceed.
    if (!last.available) return { ...last, waitedMs: Date.now() - start, timedOut: false }
    if (last.synced) return { ...last, waitedMs: Date.now() - start, timedOut: false }
    if (Date.now() - start >= timeoutMs) return { ...last, waitedMs: Date.now() - start, timedOut: true }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
