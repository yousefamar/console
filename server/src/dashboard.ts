// ============================================================================
// Dashboard helpers — server status, alerts aggregation, canvas dir.
//
// Pure-ish helpers used by the dashboard route. Each probe is best-effort;
// failures show up as non-ok statuses in the snapshot rather than route 500s.
// ============================================================================

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Session } from './session.js'
import type { CalendarSync } from './cal/sync.js'
import type { DebugLog } from './debug-log.js'

const execFileP = promisify(execFile)

// --------------------------------------------------------------------------
// Servers config (~/.config/console/dashboard-servers.json)
// --------------------------------------------------------------------------

export interface ExternalServer {
  id: string
  name: string
  url: string
  /** HTTP status code that means "healthy". Defaults to any 2xx. */
  expectStatus?: number
}

export class ServersConfig {
  private servers: ExternalServer[] = []

  constructor(private path: string) {
    this.load()
  }

  list(): ExternalServer[] {
    return [...this.servers]
  }

  add(name: string, url: string, expectStatus?: number): ExternalServer {
    const server: ExternalServer = {
      id: `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      url,
      ...(expectStatus !== undefined ? { expectStatus } : {}),
    }
    this.servers.push(server)
    this.save()
    return server
  }

  remove(id: string): boolean {
    const before = this.servers.length
    this.servers = this.servers.filter((s) => s.id !== id)
    if (this.servers.length === before) return false
    this.save()
    return true
  }

  private load(): void {
    try {
      const data = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) this.servers = parsed
    } catch { /* missing file = empty */ }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.servers, null, 2), 'utf8')
    } catch (err) {
      console.error('[dashboard] save servers failed:', (err as Error).message)
    }
  }
}

// --------------------------------------------------------------------------
// Probes
// --------------------------------------------------------------------------

export type ProbeResult =
  | { ok: true; latencyMs?: number; status?: number; detail?: string }
  | { ok: false; error: string; status?: number; latencyMs?: number }

export async function pingHost(host: string, timeoutMs = 1500): Promise<ProbeResult> {
  try {
    const t0 = Date.now()
    const { stdout } = await execFileP('ping', ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host], {
      timeout: timeoutMs + 500,
    })
    const m = stdout.match(/time[=<]([\d.]+)\s*ms/i)
    const rtt = m ? Number(m[1]) : Date.now() - t0
    return { ok: true, latencyMs: rtt }
  } catch (err) {
    return { ok: false, error: (err as Error).message.split('\n')[0] || 'ping failed' }
  }
}

export async function probeUrl(url: string, expectStatus?: number, timeoutMs = 3000): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
    const latencyMs = Date.now() - t0
    const ok = expectStatus !== undefined ? res.status === expectStatus : res.status >= 200 && res.status < 400
    if (ok) return { ok: true, latencyMs, status: res.status }
    return { ok: false, error: `HTTP ${res.status}`, status: res.status, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - t0
    const msg = (err as Error).name === 'AbortError' ? 'timeout' : ((err as Error).message || 'fetch failed')
    return { ok: false, error: msg, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

// --------------------------------------------------------------------------
// Tailscale
// --------------------------------------------------------------------------

export interface TailscaleHost {
  hostname: string
  dnsName: string
  os?: string
  online: boolean
  self: boolean
  /** Best-effort RTT to this host in ms, when online. */
  latencyMs?: number
}

interface RawTsPeer {
  HostName?: string
  DNSName?: string
  OS?: string
  Online?: boolean
  TailscaleIPs?: string[]
}

interface RawTsStatus {
  Self?: RawTsPeer
  Peer?: Record<string, RawTsPeer>
  BackendState?: string
}

export async function tailscaleHosts(): Promise<TailscaleHost[]> {
  let raw: RawTsStatus
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], { timeout: 3000 })
    raw = JSON.parse(stdout) as RawTsStatus
  } catch {
    return []
  }
  const hosts: TailscaleHost[] = []
  if (raw.Self) hosts.push(toTsHost(raw.Self, true))
  for (const peer of Object.values(raw.Peer ?? {})) hosts.push(toTsHost(peer, false))
  return hosts
}

function toTsHost(p: RawTsPeer, self: boolean): TailscaleHost {
  return {
    hostname: p.HostName ?? '?',
    dnsName: (p.DNSName ?? '').replace(/\.$/, ''),
    ...(p.OS ? { os: p.OS } : {}),
    online: !!p.Online,
    self,
  }
}

// --------------------------------------------------------------------------
// PM2
// --------------------------------------------------------------------------

export interface Pm2Process {
  name: string
  pid?: number
  status: string
  uptimeMs: number
  restartCount: number
  memoryBytes: number
  cpuPct: number
}

interface RawPm2Entry {
  name?: string
  pid?: number
  pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number }
  monit?: { memory?: number; cpu?: number }
}

export async function pm2Processes(): Promise<Pm2Process[]> {
  try {
    const { stdout } = await execFileP('pm2', ['jlist'], { timeout: 3000 })
    const list = JSON.parse(stdout) as RawPm2Entry[]
    const now = Date.now()
    return list.map((p) => ({
      name: p.name ?? '?',
      ...(typeof p.pid === 'number' && p.pid > 0 ? { pid: p.pid } : {}),
      status: p.pm2_env?.status ?? 'unknown',
      uptimeMs: typeof p.pm2_env?.pm_uptime === 'number' && p.pm2_env.status === 'online'
        ? Math.max(0, now - p.pm2_env.pm_uptime)
        : 0,
      restartCount: p.pm2_env?.restart_time ?? 0,
      memoryBytes: p.monit?.memory ?? 0,
      cpuPct: p.monit?.cpu ?? 0,
    }))
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
// Snapshot
// --------------------------------------------------------------------------

export interface DashboardSnapshot {
  generatedAt: number
  hub: { ok: true; uptimeMs: number; sessions: number }
  tailscale: TailscaleHost[]
  pm2: Pm2Process[]
  external: Array<ExternalServer & { probe: ProbeResult }>
}

const HUB_STARTED_AT = Date.now()

export async function gatherSnapshot(args: {
  servers: ServersConfig
  sessions: Map<string, Session>
}): Promise<DashboardSnapshot> {
  const [tailscale, pm2, external] = await Promise.all([
    tailscaleHosts(),
    pm2Processes(),
    Promise.all(args.servers.list().map(async (s) => ({
      ...s,
      probe: await probeUrl(s.url, s.expectStatus),
    }))),
  ])
  return {
    generatedAt: Date.now(),
    hub: { ok: true, uptimeMs: Date.now() - HUB_STARTED_AT, sessions: args.sessions.size },
    tailscale,
    pm2,
    external,
  }
}

// --------------------------------------------------------------------------
// Alerts
// --------------------------------------------------------------------------

export type DashboardAlert =
  | { kind: 'agent-approval'; sessionId: string; sessionName?: string; requestId: string; toolName: string; question?: string; ts: number }
  | { kind: 'cal-upcoming'; summary: string; startMs: number; calendarId: string }
  | { kind: 'error'; ts: number; source: string; message: string }

interface AskUserQuestionInput {
  question?: unknown
}

/** Scan a session's message log to find pending approvals (no later approve/deny). */
function pendingApprovalsForSession(session: Session): Array<{ requestId: string; toolName: string; question?: string; ts: number }> {
  const log = session.messageLog
  const resolved = new Set<string>()
  for (const m of log) {
    if (m.type === 'tool_approved' || m.type === 'tool_denied') {
      resolved.add(m.requestId)
    }
  }
  const pending: Array<{ requestId: string; toolName: string; question?: string; ts: number }> = []
  for (let i = 0; i < log.length; i++) {
    const m = log[i]!
    if (m.type !== 'approval_required') continue
    if (resolved.has(m.requestId)) continue
    const input = m.input as AskUserQuestionInput
    const question = typeof input?.question === 'string' ? input.question : undefined
    pending.push({
      requestId: m.requestId,
      toolName: m.toolName,
      ...(question ? { question } : {}),
      // Approval log entries don't carry a timestamp — fall back to session createdAt.
      ts: session.createdAt,
    })
  }
  return pending
}

export function gatherAlerts(args: {
  sessions: Map<string, Session>
  cal: CalendarSync
  debugLog: DebugLog
  upcomingWindowMs?: number
}): DashboardAlert[] {
  const alerts: DashboardAlert[] = []

  // Agent approvals (most actionable — surface first)
  for (const session of args.sessions.values()) {
    if (session.status === 'ended') continue
    for (const p of pendingApprovalsForSession(session)) {
      alerts.push({
        kind: 'agent-approval',
        sessionId: session.id,
        ...(session.name ? { sessionName: session.name } : {}),
        requestId: p.requestId,
        toolName: p.toolName,
        ...(p.question ? { question: p.question } : {}),
        ts: p.ts,
      })
    }
  }

  // Calendar — events starting within window
  const window = args.upcomingWindowMs ?? 30 * 60_000
  for (const u of args.cal.getUpcomingWithin(window)) {
    alerts.push({
      kind: 'cal-upcoming',
      summary: u.summary,
      startMs: u.startMs,
      calendarId: u.calendarId,
    })
  }

  // Errors from debug log (last 24h, dedupe by message)
  const cutoff = Date.now() - 24 * 60 * 60_000
  const lines = args.debugLog.readTail(500)
  const seen = new Set<string>()
  for (const line of lines) {
    let ev: { ts?: number; cat?: string; message?: string; status?: number; url?: string; method?: string }
    try { ev = JSON.parse(line) } catch { continue }
    if (!ev.ts || ev.ts < cutoff) continue
    const isError = ev.cat === 'error' || (ev.cat === 'net' && typeof ev.status === 'number' && ev.status >= 500)
    if (!isError) continue
    const msg = ev.message ?? (ev.url ? `${ev.method ?? 'GET'} ${ev.url} → ${ev.status}` : 'error')
    const key = `${ev.cat}:${msg}`
    if (seen.has(key)) continue
    seen.add(key)
    alerts.push({ kind: 'error', ts: ev.ts, source: ev.cat ?? 'error', message: msg })
  }

  return alerts.sort((a, b) => sortKey(b) - sortKey(a))
}

function sortKey(a: DashboardAlert): number {
  // Approvals always at top, then upcoming events by proximity, then errors by recency.
  if (a.kind === 'agent-approval') return Number.MAX_SAFE_INTEGER
  if (a.kind === 'cal-upcoming') return Number.MAX_SAFE_INTEGER - 1 - Math.max(0, a.startMs - Date.now())
  return a.ts
}

// --------------------------------------------------------------------------
// Canvas directory
// --------------------------------------------------------------------------

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Canvas</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:#0a0a0a;color:#a3a3a3;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  .wrap{display:flex;height:100%;align-items:center;justify-content:center;padding:2rem;text-align:center}
  code{background:#1a1a1a;padding:1px 6px;border-radius:3px;color:#e5e5e5;font-size:12px}
  p{max-width:42rem;margin:.5rem 0}
  /* Quiet scrollbars — agents inherit these unless they override. */
  ::-webkit-scrollbar{width:8px;height:8px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#262626;border-radius:4px}
  ::-webkit-scrollbar-thumb:hover{background:#404040}
</style></head><body><div class="wrap"><div>
  <p style="color:#737373">No canvas content yet.</p>
  <p>Agents can drop islands into <code>~/.config/console/canvas/islands/</code> or write <code>index.html</code> directly. See <code>~/CLAUDE.md</code> § Console dashboard canvas.</p>
</div></div></body></html>
`

export interface IslandMeta {
  title?: string
  agent?: string
  /** Header accent color (CSS) */
  accent?: string
  /** Grid column span 1..3 (default 1) */
  weight?: number
  /** Auto-prune at this epoch ms */
  expiresAt?: number
  /** Auto-set on write */
  createdAt?: number
}

export interface Island {
  slug: string
  html: string
  meta: IslandMeta
}

export class CanvasDir {
  constructor(public readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    mkdirSync(this.islandsDir, { recursive: true })
    // If index.html missing, compose (empty islands → placeholder).
    if (!existsSync(join(dir, 'index.html'))) this.composeIndexHtml()
  }

  get islandsDir(): string { return join(this.dir, 'islands') }

  /** Resolve a request path inside the dir. Returns null if it escapes. */
  resolve(relPath: string): string | null {
    const safe = relPath.replace(/^\/+/, '').replace(/\.\.+/g, '.')
    const full = join(this.dir, safe || 'index.html')
    if (!full.startsWith(this.dir + '/') && full !== this.dir) return null
    return full
  }

  exists(relPath: string): boolean {
    const full = this.resolve(relPath)
    if (!full) return false
    try { return statSync(full).isFile() } catch { return false }
  }

  read(relPath: string): Buffer | null {
    const full = this.resolve(relPath)
    if (!full) return null
    try { return readFileSync(full) } catch { return null }
  }

  metadata(): { updatedAt: number; sizeBytes: number; isPlaceholder: boolean; islandCount: number } {
    const idx = join(this.dir, 'index.html')
    const islandCount = this.hasIslands() ? this.listIslands().length : 0
    try {
      const st = statSync(idx)
      const buf = readFileSync(idx)
      return {
        updatedAt: st.mtimeMs,
        sizeBytes: st.size,
        isPlaceholder: buf.toString('utf8').includes('No canvas content yet.'),
        islandCount,
      }
    } catch {
      return { updatedAt: 0, sizeBytes: 0, isPlaceholder: true, islandCount }
    }
  }

  /**
   * Wipe everything in the dir (incl. islands contents) and re-seed the
   * placeholder. The islands DIR itself is preserved — deleting and
   * recreating it would invalidate the hub's inotify handle on it.
   */
  clear(): void {
    this.clearIslands()
    try {
      for (const entry of readdirSync(this.dir)) {
        if (entry === 'islands') continue
        rmSync(join(this.dir, entry), { recursive: true, force: true })
      }
    } catch { /* best effort */ }
    this.composeIndexHtml()
  }

  // ---- islands ----

  hasIslands(): boolean {
    try { return readdirSync(this.islandsDir).some((f) => f.endsWith('.html')) } catch { return false }
  }

  /** List current islands, pruning expired ones as a side effect. */
  listIslands(): Island[] {
    let files: string[]
    try { files = readdirSync(this.islandsDir).filter((f) => f.endsWith('.html')) } catch { return [] }
    const now = Date.now()
    const islands: Island[] = []
    for (const file of files.sort()) {
      const slug = file.replace(/\.html$/, '')
      const htmlPath = join(this.islandsDir, file)
      const metaPath = join(this.islandsDir, `${slug}.json`)
      let html = ''
      try { html = readFileSync(htmlPath, 'utf8') } catch { continue }
      let meta: IslandMeta = {}
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { /* no meta */ }
      if (meta.expiresAt && meta.expiresAt < now) {
        try { rmSync(htmlPath) } catch {}
        try { rmSync(metaPath) } catch {}
        continue
      }
      islands.push({ slug, html, meta })
    }
    return islands
  }

  /** Write or replace an island. Slug is sanitised. Returns the saved slug. */
  writeIsland(slug: string, html: string, meta?: IslandMeta): string {
    const safe = sanitiseSlug(slug)
    if (!safe) throw new Error('invalid slug')
    mkdirSync(this.islandsDir, { recursive: true })
    writeFileSync(join(this.islandsDir, `${safe}.html`), html, 'utf8')
    if (meta && Object.keys(meta).length > 0) {
      const finalMeta: IslandMeta = { ...meta, createdAt: meta.createdAt ?? Date.now() }
      writeFileSync(join(this.islandsDir, `${safe}.json`), JSON.stringify(finalMeta, null, 2), 'utf8')
    } else {
      // Touch a minimal meta file so createdAt survives across reads.
      writeFileSync(join(this.islandsDir, `${safe}.json`), JSON.stringify({ createdAt: Date.now() }, null, 2), 'utf8')
    }
    return safe
  }

  removeIsland(slug: string): boolean {
    const safe = sanitiseSlug(slug)
    if (!safe) return false
    let removed = false
    for (const ext of ['html', 'json']) {
      const p = join(this.islandsDir, `${safe}.${ext}`)
      try { rmSync(p); if (ext === 'html') removed = true } catch {}
    }
    return removed
  }

  clearIslands(): void {
    try {
      for (const f of readdirSync(this.islandsDir)) {
        try { rmSync(join(this.islandsDir, f), { recursive: true, force: true }) } catch {}
      }
    } catch { /* best effort */ }
  }

  /**
   * Regenerate index.html. If any islands exist, compose them into a grid
   * shell. Otherwise re-seed the placeholder.
   */
  composeIndexHtml(): string {
    const islands = this.listIslands()
    const html = islands.length > 0 ? composeIslands(islands) : PLACEHOLDER_HTML
    try {
      writeFileSync(join(this.dir, 'index.html'), html, 'utf8')
    } catch (err) {
      console.error('[dashboard] compose index failed:', (err as Error).message)
    }
    return html
  }
}

function sanitiseSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function composeIslands(islands: Island[]): string {
  const cards = islands.map((i) => {
    const span = Math.max(1, Math.min(3, i.meta.weight ?? 1))
    const accent = i.meta.accent || '#262626'
    const title = i.meta.title ?? i.slug
    const agent = i.meta.agent ?? ''
    const created = i.meta.createdAt
      ? `<time datetime="${new Date(i.meta.createdAt).toISOString()}">${formatAgo(Date.now() - i.meta.createdAt)}</time>`
      : ''
    return `<article class="island" data-slug="${escapeAttr(i.slug)}" style="grid-column:span ${span}">
  <header style="border-bottom-color:${escapeAttr(accent)}">
    <strong>${escapeHtml(title)}</strong>
    <span class="meta">${escapeHtml(agent)}${agent && created ? ' · ' : ''}${created}</span>
  </header>
  <div class="body">${i.html}</div>
</article>`
  }).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Canvas</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0a0a0a;color:#e5e5e5;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  body{overflow-y:auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding:12px}
  .island{display:flex;flex-direction:column;background:#141414;border:1px solid #262626;border-radius:6px;overflow:hidden;min-height:140px}
  .island > header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:2px solid #262626;background:#1a1a1a;font-size:11px;color:#a3a3a3;gap:8px}
  .island > header strong{color:#e5e5e5;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .island > header .meta{font-size:10px;color:#737373;flex-shrink:0}
  .island > .body{padding:10px;flex:1;min-height:0;overflow:auto}
  ::-webkit-scrollbar{width:8px;height:8px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#262626;border-radius:4px}
  ::-webkit-scrollbar-thumb:hover{background:#404040}
</style></head><body>
<div class="grid">
${cards}
</div>
</body></html>
`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
function escapeAttr(s: string): string { return escapeHtml(s) }
function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function contentTypeFor(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8'
    case 'css': return 'text/css; charset=utf-8'
    case 'js': case 'mjs': return 'text/javascript; charset=utf-8'
    case 'json': return 'application/json; charset=utf-8'
    case 'svg': return 'image/svg+xml'
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'ico': return 'image/x-icon'
    case 'txt': case 'md': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}
