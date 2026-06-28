// Hub-side pen client — talks to the APK's PushService over the `/push`
// WebSocket using the same tiny request/response RPC framing as the glasses
// subsystem.
//
// Topology reminder (mirrors `glasses-hub.ts`):
//   hub ──(WS /push)──▶ APK PushService ──▶ PenController ──▶ BLE ──▶ Neo pen
// The hub never touches BLE itself — the pen is physically near the phone.
//
// Frame shapes (on top of the existing PushMessage stream):
//
//   hub  → APK:   { type: 'rpc_request',  id, method, params }
//   APK  → hub:   { type: 'rpc_response', id, ok, result?, error? }
//   APK  → hub:   { type: 'pen_state', state: <PenSnapshot> }
//   APK  → hub:   { type: 'pen_frame', kind, hex, ts }
//   APK  → hub:   { type: 'pen_scan_observation', name, mac, rssi, ts }
//
// APK side lives in `android/app/src/main/kotlin/io/amar/console/PushService.kt`
// and `android/app/src/main/kotlin/io/amar/console/pen/*` (see PenState /
// PenController).

import type { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PushServer } from './push.js'
import type { GlassesResearchLog, ResearchFrame } from './glasses/research-log.js'
import type { NoteStore } from './notes.js'
import type { SyncBus } from './sync-bus.js'
import { decodeEventFrame } from './pen/page-codec.js'
import { PenPageAssembler } from './pen/page-assembler.js'

export type PenStatus = 'disconnected' | 'connecting' | 'connected'

export interface PenSnapshot {
  status: PenStatus
  mac: string | null
  name: string | null
  firmware: string | null
  battery: number | null
  usedMemPct: number | null
  locked: boolean
  authorized: boolean
  offlineSaveOn: boolean | null
  lastError: string | null
  lastDotX: number | null
  lastDotY: number | null
  lastUpdatedMs: number
}

export interface PenDevice {
  mac: string
  name: string | null
  has19f1: boolean
}

export interface PenScanObservation {
  name: string
  mac: string
  rssi: number
  ts: number
  has19f1?: boolean
}

/** Identifies one stored note in the pen's offline memory (NeoLAB addressing). */
export interface PenOfflineNote {
  section: number
  owner: number
  note: number
}

/** A note plus the list of page ids it holds (result of `pen_offline_pages`). */
export interface PenOfflinePages {
  section: number
  owner: number
  note: number
  pages: number[]
}

/** Progress record for the page transfer currently being received (or the last one). */
export interface PenOfflineProgress {
  section: number
  owner: number
  note: number
  page: number
  totalSize: number
  received: number
  done: boolean
  startedAt: number
  /** Final on-disk byte size; set on `pen_offline_done`. */
  fileSize?: number
  /** Absolute path of the .bin we're writing the rescued bytes to. */
  file: string
}

/** A saved offline-data file under the pen offline dir. */
export interface PenOfflineFile {
  name: string
  path: string
  size: number
  mtimeMs: number
}

type Pending = {
  resolve: (val: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PenHub {
  private readonly pending = new Map<string, Pending>()
  private cachedState: PenSnapshot | null = null
  private cachedAt = 0
  private readonly log: (msg: string) => void
  private readonly researchLog: GlassesResearchLog | null
  /**
   * Ring buffer of the most recent BLE scan observations (every named
   * advertisement the APK saw during a scan, regardless of whether it matched
   * the pen name/service heuristic). Used to diagnose "scan found no pen".
   */
  private readonly scanObservations: PenScanObservation[] = []
  private static readonly SCAN_OBS_MAX = 200

  // --- offline-data rescue state ------------------------------------------
  /** Last enumeration of stored notes (from a `pen_offline_notes` message). */
  private lastNotes: PenOfflineNote[] = []
  /** Last page listing for a note (from a `pen_offline_pages` message). */
  private lastPages: PenOfflinePages | null = null
  /** The currently-active (or most-recent) page transfer's progress record. */
  private offlineProgress: PenOfflineProgress | null = null
  /** Where rescued page bytes land: `~/.config/console/pen/offline/`. */
  private readonly offlineDir = join(homedir(), '.config', 'console', 'pen', 'offline')

  /** Assembles live stroke events into per-page SVGs in the vault (null if no NoteStore). */
  private readonly assembler: PenPageAssembler | null

  // --- persisted pen config (auto-unlock PIN + live-stream opt-in) ---------
  /** Confirmed-good unlock PIN, persisted so reconnects auto-unlock. */
  private savedPassword: string | null = null
  /** PIN of the most recent unlock attempt (manual or auto) — persisted only
   *  once we OBSERVE the pen authorize with it (never a guessed PIN). */
  private lastUnlockPin: string | null = null
  /** One auto-unlock attempt per connection (re-armed on disconnect). */
  private autoUnlockAttempted = false
  /** Opt-in: when true the hub registers AddUsingNotes (0x11) on every connect
   *  so the pen STREAMS live dots into Notes. Off by default — leaves the pen's
   *  native offline-save behaviour untouched (and the two coexist when on). */
  private streamEnabled = false
  /** One stream-register per connection (re-armed on disconnect). */
  private streamRegistered = false
  /** Last broadcast streaming-active value — dedups the SyncBus `streaming` event. */
  private lastStreamingBroadcast = false
  /** SyncBus for broadcasting streaming state to the SPA (null in tests). */
  private readonly syncBus: SyncBus | null
  /** Where the persisted pen config lives (mode 0600). */
  private readonly authFile = join(homedir(), '.config', 'console', 'pen-auth.json')

  constructor(
    private readonly push: PushServer,
    log: (msg: string) => void,
    researchLog: GlassesResearchLog | null = null,
    noteStore: NoteStore | null = null,
    syncBus: SyncBus | null = null,
  ) {
    this.log = log
    this.researchLog = researchLog
    this.syncBus = syncBus
    this.assembler = noteStore
      ? new PenPageAssembler(noteStore, (op, data) => syncBus?.broadcast('pen', op, data))
      : null
    const cfg = this.loadConfig()
    this.savedPassword = cfg.password
    this.streamEnabled = cfg.streamEnabled
  }

  /**
   * Called by the WebSocket message handler (`/push` connection) for every
   * inbound frame from the APK. Returns true if the frame was consumed.
   */
  handleMessage(_ws: WebSocket, frame: unknown): boolean {
    if (!frame || typeof frame !== 'object') return false
    const f = frame as Record<string, unknown>
    if (f.type === 'rpc_response' && typeof f.id === 'string') {
      const p = this.pending.get(f.id)
      if (!p) return false
      this.pending.delete(f.id)
      clearTimeout(p.timer)
      if (f.ok) p.resolve(f.result)
      else p.reject(new Error(typeof f.error === 'string' ? f.error : 'rpc failed'))
      return true
    }
    if (f.type === 'pen_state' && f.state && typeof f.state === 'object') {
      const prev = this.cachedState
      this.cachedState = f.state as PenSnapshot
      this.cachedAt = Date.now()
      this.onStateUpdate(prev, this.cachedState)
      return true
    }
    if (
      f.type === 'pen_scan_observation' &&
      typeof f.name === 'string' &&
      typeof f.mac === 'string' &&
      typeof f.rssi === 'number'
    ) {
      const obs: PenScanObservation = {
        name: f.name,
        mac: f.mac,
        rssi: f.rssi,
        ts: typeof f.ts === 'number' ? f.ts : Date.now(),
        has19f1: f.has19f1 === true,
      }
      this.scanObservations.push(obs)
      while (this.scanObservations.length > PenHub.SCAN_OBS_MAX) {
        this.scanObservations.shift()
      }
      // Also echo into the (shared) research log for offline analysis.
      this.researchLog?.append({
        arm: 'pen',
        hex: '',
        kind: 'scan_observation',
        ts: obs.ts,
        name: obs.name,
        mac: obs.mac,
        rssi: obs.rssi,
      })
      return true
    }
    if (
      f.type === 'pen_frame' &&
      typeof f.hex === 'string' &&
      typeof f.kind === 'string'
    ) {
      // Reverse-engineering aid. Unknown opcodes get flagged so the CLI /
      // analysis scripts can filter them cheaply.
      this.researchLog?.append({
        arm: 'pen',
        hex: f.hex,
        kind: f.kind,
        ts: typeof f.ts === 'number' ? f.ts : Date.now(),
        ...(f.kind === 'unhandled' ? { unknown: true } : {}),
      })
      // Live stroke events → assemble per-page SVG in the vault + broadcast for live render.
      if (f.kind === 'dot' && this.assembler) {
        const ev = decodeEventFrame(f.hex)
        if (ev) this.assembler.onFrame(ev.cmd, ev.data)
      }
      return true
    }

    // --- offline-data rescue (APK → hub) -----------------------------------
    if (f.type === 'pen_offline_notes' && Array.isArray(f.notes)) {
      this.lastNotes = (f.notes as Record<string, unknown>[])
        .filter((n) => n && typeof n === 'object')
        .map((n) => ({
          section: Number(n.section) || 0,
          owner: Number(n.owner) || 0,
          note: Number(n.note) || 0,
        }))
      return true
    }
    if (
      f.type === 'pen_offline_pages' &&
      Array.isArray(f.pages) &&
      typeof f.section === 'number' &&
      typeof f.owner === 'number' &&
      typeof f.note === 'number'
    ) {
      this.lastPages = {
        section: f.section,
        owner: f.owner,
        note: f.note,
        pages: (f.pages as unknown[]).map((p) => Number(p)).filter((p) => Number.isFinite(p)),
      }
      return true
    }
    if (
      f.type === 'pen_offline_start' &&
      typeof f.section === 'number' &&
      typeof f.owner === 'number' &&
      typeof f.note === 'number' &&
      typeof f.page === 'number'
    ) {
      const file = this.pageFilePath(f.section, f.owner, f.note, f.page)
      try {
        mkdirSync(this.offlineDir, { recursive: true })
        // Open/create + truncate — start every transfer with a clean file.
        writeFileSync(file, Buffer.alloc(0))
      } catch (err) {
        this.log(`[pen] offline_start: failed to open ${file}: ${(err as Error).message}`)
      }
      this.offlineProgress = {
        section: f.section,
        owner: f.owner,
        note: f.note,
        page: f.page,
        totalSize: typeof f.totalSize === 'number' ? f.totalSize : 0,
        received: 0,
        done: false,
        startedAt: Date.now(),
        file,
      }
      return true
    }
    if (
      f.type === 'pen_offline_chunk' &&
      typeof f.hex === 'string' &&
      typeof f.section === 'number' &&
      typeof f.owner === 'number' &&
      typeof f.note === 'number' &&
      typeof f.page === 'number'
    ) {
      // Decode the hex and APPEND immediately — this is the rescued data, so
      // never buffer-and-maybe-lose: write each chunk to disk as it arrives.
      const file = this.pageFilePath(f.section, f.owner, f.note, f.page)
      try {
        const bytes = Buffer.from(f.hex, 'hex')
        appendFileSync(file, bytes)
        if (
          this.offlineProgress &&
          this.offlineProgress.section === f.section &&
          this.offlineProgress.owner === f.owner &&
          this.offlineProgress.note === f.note &&
          this.offlineProgress.page === f.page
        ) {
          this.offlineProgress.received += bytes.length
        }
      } catch (err) {
        this.log(`[pen] offline_chunk: failed to write ${file}: ${(err as Error).message}`)
      }
      // Optional RE echo so the raw transfer is correlatable in the log too.
      this.researchLog?.append({
        arm: 'pen',
        hex: f.hex,
        kind: 'offline_chunk',
        ts: typeof f.ts === 'number' ? f.ts : Date.now(),
      })
      return true
    }
    if (
      f.type === 'pen_offline_done' &&
      typeof f.section === 'number' &&
      typeof f.owner === 'number' &&
      typeof f.note === 'number' &&
      typeof f.page === 'number'
    ) {
      if (
        this.offlineProgress &&
        this.offlineProgress.section === f.section &&
        this.offlineProgress.owner === f.owner &&
        this.offlineProgress.note === f.note &&
        this.offlineProgress.page === f.page
      ) {
        this.offlineProgress.done = true
        try {
          this.offlineProgress.fileSize = statSync(this.offlineProgress.file).size
        } catch {
          this.offlineProgress.fileSize = this.offlineProgress.received
        }
      }
      return true
    }
    return false
  }

  /** Resolve the on-disk path for one rescued page's raw bytes. */
  private pageFilePath(section: number, owner: number, note: number, page: number): string {
    return join(this.offlineDir, `${section}-${owner}-${note}-${page}.bin`)
  }

  /** Last snapshot the APK pushed; null if no APK has connected yet. */
  getCachedState(): { state: PenSnapshot | null; ageMs: number } {
    return {
      state: this.cachedState,
      ageMs: this.cachedState ? Date.now() - this.cachedAt : -1,
    }
  }

  /** True if at least one APK is currently connected. */
  hasClient(): boolean {
    return this.push.clientCount() > 0
  }

  // --- remembered-PIN auto-unlock -----------------------------------------

  /** Drives auto-unlock + PIN-persistence off every pushed pen_state. */
  private onStateUpdate(_prev: PenSnapshot | null, state: PenSnapshot): void {
    const connected = state.status === 'connected'

    // Re-arm the per-connection one-shots for the next connection.
    if (!connected) {
      this.autoUnlockAttempted = false
      this.lastUnlockPin = null
      this.streamRegistered = false
    }

    // Persist a PIN the instant we SEE it authorize the pen (manual or auto).
    if (state.authorized && this.lastUnlockPin && this.lastUnlockPin !== this.savedPassword) {
      this.setSavedPassword(this.lastUnlockPin)
      this.log('[pen] remembered PIN — future connects will auto-unlock')
    }

    // Auto-unlock: connected + locked + a remembered PIN + not yet tried this
    // connection. Exactly ONE attempt; armAutoUnlock forgets the PIN if it
    // fails, so a wrong PIN can never be re-sent (the v33 retry-counter lesson).
    if (connected && state.locked && !state.authorized && this.savedPassword && !this.autoUnlockAttempted) {
      this.autoUnlockAttempted = true
      this.armAutoUnlock(this.savedPassword)
    }

    // Live-stream opt-in: once authorized, register AddUsingNotes so the pen
    // streams live dots into Notes. One registration per connection.
    if (connected && state.authorized && this.streamEnabled && !this.streamRegistered) {
      this.streamRegistered = true
      this.registerLiveStream()
    }

    this.broadcastStreaming()
  }

  /** Whether the pen is currently live-streaming (enabled + connected + registered). */
  isStreamingActive(): boolean {
    return (
      this.streamEnabled &&
      this.cachedState?.status === 'connected' &&
      !!this.cachedState?.authorized &&
      this.streamRegistered
    )
  }

  /** Broadcast the streaming-active state to the SPA on change (drives the Notes-tab dot). */
  private broadcastStreaming(): void {
    const active = this.isStreamingActive()
    if (active !== this.lastStreamingBroadcast) {
      this.lastStreamingBroadcast = active
      this.syncBus?.broadcast('pen', 'streaming', { active })
    }
  }

  /** Send AddUsingNotes (0x11, all-notes) so the pen streams live dots. Coexists
   *  with offline-save (the pen keeps backing strokes to flash), so enabling it
   *  never costs the durable backup. */
  private registerLiveStream(): void {
    this.log('[pen] enabling live streaming (AddUsingNotes all)')
    this.sendRaw(0x11, 'ffff').catch((e) => this.log(`[pen] stream register failed: ${(e as Error).message}`))
  }


  private armAutoUnlock(pin: string): void {
    this.log('[pen] auto-unlocking with remembered PIN')
    this.unlock(pin).catch((e) => this.log(`[pen] auto-unlock send failed: ${(e as Error).message}`))
    // Verify it authorized. Still locked a few seconds later ⇒ the stored PIN is
    // wrong (pen's PIN changed) ⇒ FORGET it so we never burn the retry counter.
    setTimeout(() => {
      const s = this.cachedState
      if (s && s.status === 'connected' && s.locked && !s.authorized) {
        this.log('[pen] auto-unlock did not authorize — forgetting saved PIN; unlock manually')
        this.setSavedPassword(null)
      }
    }, 8000)
  }

  private loadConfig(): { password: string | null; streamEnabled: boolean } {
    try {
      const j = JSON.parse(readFileSync(this.authFile, 'utf-8'))
      const password = typeof j?.password === 'string' && j.password.length > 0 ? j.password : null
      return { password, streamEnabled: j?.streamEnabled === true }
    } catch {
      return { password: null, streamEnabled: false }
    }
  }

  private persistConfig(): void {
    try {
      mkdirSync(join(homedir(), '.config', 'console'), { recursive: true })
      writeFileSync(
        this.authFile,
        JSON.stringify({ password: this.savedPassword, streamEnabled: this.streamEnabled }),
        { mode: 0o600 },
      )
    } catch (err) {
      this.log(`[pen] failed to persist pen-auth.json: ${(err as Error).message}`)
    }
  }

  private setSavedPassword(pin: string | null): void {
    this.savedPassword = pin
    this.persistConfig()
  }

  /** Whether live-streaming-into-Notes is enabled (opt-in, persisted). */
  isStreamEnabled(): boolean {
    return this.streamEnabled
  }

  /** Enable/disable live streaming. Enabling while already connected+authorized
   *  registers immediately; disabling takes effect on the next connection (the
   *  pen keeps streaming until then). */
  setStreamEnabled(enabled: boolean): { streaming: boolean } {
    this.streamEnabled = enabled
    this.persistConfig()
    this.streamRegistered = false
    // The pen's only role here is live capture, and the firmware has no
    // "connected but idle" state — the BLE LED keeps flashing and an empty
    // AddUsingNotes stops the dot data but not the indicator. So the toggle
    // controls the CONNECTION: off → disconnect (pen reverts to its standalone
    // offline-save), on → connect (auto-unlock + register stream via
    // onStateUpdate, or register now if already connected+authorized).
    if (this.hasClient()) {
      if (enabled) {
        const s = this.cachedState
        if (s && s.status === 'connected' && s.authorized) {
          this.streamRegistered = true
          this.registerLiveStream()
        } else {
          this.connect().catch((e) => this.log(`[pen] stream-on connect failed: ${(e as Error).message}`))
        }
      } else {
        this.disconnect().catch((e) => this.log(`[pen] stream-off disconnect failed: ${(e as Error).message}`))
      }
    }
    this.broadcastStreaming()
    return { streaming: this.streamEnabled }
  }

  // --- RPC helpers ---------------------------------------------------------

  private async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.hasClient()) {
      throw new Error('no APK connected to hub')
    }
    const id = randomUUID()
    const payload = JSON.stringify({ type: 'rpc_request', id, method, params })
    // Broadcast to every push client. Typically there's just one (the user's
    // phone); if multiple APKs are connected the first to answer wins.
    this.push.broadcastRaw(payload)
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })
    })
  }

  // --- Public commands -----------------------------------------------------

  async status(): Promise<PenSnapshot> {
    return await this.rpc<PenSnapshot>('pen_status')
  }

  async listDevices(): Promise<{ devices: PenDevice[] }> {
    return await this.rpc<{ devices: PenDevice[] }>('pen_listDevices')
  }

  async connect(mac?: string): Promise<{ ok: boolean; mac: string | null }> {
    return await this.rpc('pen_connect', mac ? { mac } : {})
  }

  async disconnect(): Promise<{ ok: boolean }> {
    return await this.rpc('pen_disconnect')
  }

  async scan(durationMs = 15_000): Promise<{ ok: boolean; durationMs: number }> {
    return await this.rpc('pen_scan', { durationMs })
  }

  async stopScan(): Promise<{ ok: boolean }> {
    return await this.rpc('pen_stopScan')
  }

  async unlock(password: string): Promise<{ ok: boolean }> {
    // Remember which PIN we sent so onStateUpdate can persist it once the pen
    // actually authorizes (only a CONFIRMED-good PIN is ever stored).
    this.lastUnlockPin = password
    return await this.rpc('pen_unlock', { password })
  }

  /** Forget the remembered auto-unlock PIN (next connect needs a manual unlock). */
  forgetPassword(): { remembered: boolean } {
    this.setSavedPassword(null)
    return { remembered: false }
  }

  /** Whether an auto-unlock PIN is currently remembered (not the PIN itself). */
  hasRememberedPassword(): boolean {
    return this.savedPassword != null
  }

  /** Debug: send an arbitrary cmd (int) + payload (hex string) to the pen. The
   *  APK refuses destructive opcodes; this is for probing the offline gate. */
  async sendRaw(cmd: number, data: string): Promise<{ ok: boolean }> {
    return await this.rpc('pen_raw', { cmd, data })
  }

  // --- offline-data rescue commands ---------------------------------------

  /** Trigger enumeration of stored notes; result arrives via `pen_offline_notes`. */
  async reqOfflineNotes(): Promise<{ ok: boolean }> {
    return await this.rpc('pen_offline_notes')
  }

  /** Trigger page enumeration for a note; result via `pen_offline_pages`. */
  async reqOfflinePages(section: number, owner: number, note: number): Promise<{ ok: boolean }> {
    return await this.rpc('pen_offline_pages', { section, owner, note })
  }

  /**
   * Trigger a non-destructive pull of one page's raw bytes. Data arrives async
   * via `pen_offline_start` / `pen_offline_chunk` / `pen_offline_done`; poll
   * `getOfflineProgress()` (or `GET /pen/offline/progress`) to follow along.
   */
  async pullPage(section: number, owner: number, note: number, page: number): Promise<{ ok: boolean }> {
    return await this.rpc('pen_offline_pull', { section, owner, note, page })
  }

  /** Last enumerated list of stored notes (empty until `reqOfflineNotes`). */
  getOfflineNotes(): PenOfflineNote[] {
    return this.lastNotes
  }

  /** Last enumerated page listing for a note (null until `reqOfflinePages`). */
  getOfflinePages(): PenOfflinePages | null {
    return this.lastPages
  }

  /** The current/most-recent page transfer's progress record (null if none). */
  getOfflineProgress(): PenOfflineProgress | null {
    return this.offlineProgress
  }

  /** List the rescued .bin files saved under the offline dir (with sizes). */
  listOfflineFiles(): PenOfflineFile[] {
    let names: string[]
    try {
      names = readdirSync(this.offlineDir)
    } catch {
      return []
    }
    const files: PenOfflineFile[] = []
    for (const name of names) {
      if (!name.endsWith('.bin')) continue
      const p = join(this.offlineDir, name)
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        files.push({ name, path: p, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // skip unreadable entries
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /** Snapshot of recent observed advertisements during scans (oldest first). */
  getScanObservations(): PenScanObservation[] {
    // Dedupe by MAC: strongest RSSI, OR the pen-service flag, newest ts/name.
    const byMac = new Map<string, PenScanObservation>()
    for (const o of this.scanObservations) {
      const prev = byMac.get(o.mac)
      if (!prev) { byMac.set(o.mac, { ...o }); continue }
      byMac.set(o.mac, {
        name: o.name !== '(unnamed)' ? o.name : prev.name,
        mac: o.mac,
        rssi: Math.max(prev.rssi, o.rssi),
        ts: Math.max(prev.ts, o.ts),
        has19f1: prev.has19f1 === true || o.has19f1 === true,
      })
    }
    const isPen = (o: PenScanObservation) =>
      o.has19f1 === true || /pen|neo|nwp|moleskine|smart/i.test(o.name)
    return [...byMac.values()]
      // Drop the unnamed BLE noise — the pen advertises a name ("Smart Pen").
      .filter((o) => o.name !== '(unnamed)' || o.has19f1 === true)
      // Likely-pen first, then 0x19F1-flagged, then strongest signal.
      .sort(
        (a, b) =>
          Number(isPen(b)) - Number(isPen(a)) ||
          Number(b.has19f1 ?? false) - Number(a.has19f1 ?? false) ||
          b.rssi - a.rssi,
      )
  }

  /**
   * Toggle verbose research-mode frame forwarding on the APK. When verbose,
   * heartbeat frames are also shipped to the research log; otherwise only the
   * more interesting frames are forwarded.
   */
  async setResearch(verbose: boolean): Promise<{ verbose: boolean }> {
    return await this.rpc('pen_setResearch', { verbose })
  }

  /** Read the last N entries from the (shared) research log (empty if none). */
  tailResearchLog(n: number): ResearchFrame[] {
    return this.researchLog?.tail(n) ?? []
  }
}
