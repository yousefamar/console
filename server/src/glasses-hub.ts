// Hub-side glasses client — talks to the APK's PushService over the `/push`
// WebSocket using a tiny request/response RPC framing.
//
// Topology reminder (see `docs/g1-protocol.md`):
//   hub ──(WS /push)──▶ APK PushService ──▶ GlassesController ──▶ BLE ──▶ G1
// The hub never touches BLE itself — the glasses are physically near the phone.
//
// Frame shapes (on top of existing PushMessage stream):
//
//   hub  → APK:   { type: 'rpc_request',  id, method, params }
//   APK  → hub:   { type: 'rpc_response', id, ok, result?, error? }
//   APK  → hub:   { type: 'glasses_state', state: <GlassesSnapshot> }
//
// APK side lives in `android/app/src/main/kotlin/io/amar/console/PushService.kt`
// (see `handleHubRpc` / `emitGlassesStateToHub`).

import type { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { PushServer } from './push.js'
import type { GlassesResearchLog, ResearchFrame } from './glasses/research-log.js'

export type GlassesArmStatus = 'disconnected' | 'connecting' | 'connected'

export interface GlassesArmSnapshot {
  status: GlassesArmStatus
  mac: string | null
  battery: number | null
  /** True when the arm is sitting on its case charging pin (from `0xF5 0x09`). */
  charging: boolean | null
  serial: string | null
}

export interface GlassesSnapshot {
  connected: boolean
  left: GlassesArmSnapshot
  right: GlassesArmSnapshot
  channel: string | null
  micActive: boolean
  /** On-head wear state from 0x27 events; null until reported. */
  worn: boolean | null
  /** Charging-case battery % (0..100) from 0xF5 subcmd 0x0F. */
  caseBattery: number | null
  /** Charging-case charging state from 0xF5 subcmd 0x0E. */
  caseCharging: boolean | null
  /** Phone battery % (0..100), injected by PushService; null if unknown. */
  phoneBattery?: number | null
  /**
   * Feature id currently drawn on the lens, from a `0x39` query (docs §19):
   * 0 = idle screen, 0xFF = firmware has none stored, null = never asked.
   * Optional — an older APK's snapshot won't carry it.
   */
  runningApp?: number | null
  lastError: string | null
  lastUpdatedMs: number
}

export interface GlassesNotifyRequest {
  appIdentifier: string
  /** Human-readable source shown on the card (e.g. "Mail", "Chat"). Rides the
   *  0x4B `display_name`; the appIdentifier itself stays the whitelisted id. */
  displayName?: string
  title: string
  subtitle: string
  message: string
  timestamp?: number
}

/** One turn-by-turn update for the glasses' native nav card (0x0A sub 1) — see docs/g1-protocol.md §18. */
export interface GlassesNavStep {
  /** Pictogram id 1..35 (1 straight, 4 left, 5 right, 10 U-turn, …). */
  direction: number
  /** Road name — ≤63 UTF-8 bytes. Drawn centre in the overview view. */
  road: string
  /** Distance to the manoeuvre ("200 m") — ≤23 bytes, bottom-left. */
  distance: string
  /** Time remaining for the route ("12 min") — ≤23 bytes, top-right with `remaining`. */
  eta?: string
  /** Distance remaining for the route ("3.4 km") — ≤23 bytes. */
  remaining?: string
  /** Current speed text — ≤23 bytes, panoramic view only. */
  speed?: string
  /** Position marker on the panoramic map, 0..488 × 0..136. */
  x?: number
  y?: number
}

/** The APK relays the RIGHT arm's ack: `status` is the firmware's byte-5 result, `ack` the raw frame in hex. */
export interface GlassesNavAck {
  ok: boolean
  status?: number
  ack?: string
  error?: string
}

type Pending = {
  resolve: (val: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface GlassesAudioFrame {
  seq: number
  lc3b64: string
}

export interface GlassesTouchFrame {
  arm: 'left' | 'right'
  subcmd: number
}

export interface GlassesScanObservation {
  name: string
  mac: string
  rssi: number
  ts: number
}

export class GlassesHub {
  private readonly pending = new Map<string, Pending>()
  private cachedState: GlassesSnapshot | null = null
  private cachedAt = 0
  private readonly log: (msg: string) => void
  private readonly audioSubs = new Set<(f: GlassesAudioFrame) => void>()
  private readonly touchSubs = new Set<(f: GlassesTouchFrame) => void>()
  private readonly researchLog: GlassesResearchLog | null
  /**
   * Ring buffer of the most recent BLE scan observations (every named
   * advertisement the APK saw, regardless of whether it matched the G1
   * regex). Used to diagnose "scan found no glasses" — reveals whether
   * the glasses are advertising at all, and under what name.
   */
  private readonly scanObservations: GlassesScanObservation[] = []
  private static readonly SCAN_OBS_MAX = 200
  /**
   * Rolling 0x4B message id. 1..255 — the wire field is one byte, and 0 is
   * skipped so a card id is always truthy.
   */
  private nextMsgId = 1

  constructor(
    private readonly push: PushServer,
    log: (msg: string) => void,
    researchLog: GlassesResearchLog | null = null,
  ) {
    this.log = log
    this.researchLog = researchLog
  }

  onAudio(fn: (f: GlassesAudioFrame) => void): () => void {
    this.audioSubs.add(fn)
    return () => this.audioSubs.delete(fn)
  }

  onTouch(fn: (f: GlassesTouchFrame) => void): () => void {
    this.touchSubs.add(fn)
    return () => this.touchSubs.delete(fn)
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
      if (!p) return true
      this.pending.delete(f.id)
      clearTimeout(p.timer)
      if (f.ok) p.resolve(f.result)
      else p.reject(new Error(typeof f.error === 'string' ? f.error : 'rpc failed'))
      return true
    }
    // PTT hardware-button probe (APK v25): forward of any captured Zello/
    // vendor PTT broadcast. Discovery-only — we log the action + extras so we
    // can see what the phone's Custom key actually emits, then wire real PTT.
    if (f.type === 'ptt_button') {
      this.log(`[ptt-probe] action=${String(f.action)} extras=${JSON.stringify(f.extras ?? {})}`)
      return true
    }
    if (f.type === 'glasses_state' && f.state && typeof f.state === 'object') {
      this.cachedState = f.state as GlassesSnapshot
      this.cachedAt = Date.now()
      return true
    }
    if (f.type === 'glasses_audio' && typeof f.seq === 'number' && typeof f.lc3b64 === 'string') {
      const frame: GlassesAudioFrame = { seq: f.seq, lc3b64: f.lc3b64 }
      for (const s of this.audioSubs) { try { s(frame) } catch { /* ignore */ } }
      return true
    }
    if (f.type === 'glasses_touch' && (f.arm === 'left' || f.arm === 'right') && typeof f.subcmd === 'number') {
      const frame: GlassesTouchFrame = { arm: f.arm, subcmd: f.subcmd }
      for (const s of this.touchSubs) { try { s(frame) } catch { /* ignore */ } }
      return true
    }
    if (
      f.type === 'glasses_scan_observation' &&
      typeof f.name === 'string' &&
      typeof f.mac === 'string' &&
      typeof f.rssi === 'number'
    ) {
      const obs: GlassesScanObservation = {
        name: f.name,
        mac: f.mac,
        rssi: f.rssi,
        ts: typeof f.ts === 'number' ? f.ts : Date.now(),
      }
      this.scanObservations.push(obs)
      while (this.scanObservations.length > GlassesHub.SCAN_OBS_MAX) {
        this.scanObservations.shift()
      }
      // Also echo into the research log for offline analysis.
      this.researchLog?.append({
        arm: 'scan',
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
      f.type === 'glasses_frame' &&
      (f.arm === 'left' || f.arm === 'right') &&
      typeof f.hex === 'string' &&
      typeof f.kind === 'string'
    ) {
      // Reverse-engineering aid. Unknown opcodes get flagged so the CLI /
      // analysis scripts can filter them cheaply.
      this.researchLog?.append({
        arm: f.arm,
        hex: f.hex,
        kind: f.kind,
        ts: typeof f.ts === 'number' ? f.ts : Date.now(),
        ...(f.kind === 'unhandled' ? { unknown: true } : {}),
      })
      return true
    }
    return false
  }

  /** Last snapshot the APK pushed; null if no APK has connected yet. */
  getCachedState(): { state: GlassesSnapshot | null; ageMs: number } {
    return {
      state: this.cachedState,
      ageMs: this.cachedState ? Date.now() - this.cachedAt : -1,
    }
  }

  /** True if at least one APK is currently connected. */
  hasClient(): boolean {
    return this.push.clientCount() > 0
  }

  /** Next 0x4B msgId, wrapping 1..255. */
  allocMsgId(): number {
    const id = this.nextMsgId
    this.nextMsgId = (this.nextMsgId % 255) + 1
    return id
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
    // PushServer does not expose a direct send, so we reuse broadcast.
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

  async status(): Promise<GlassesSnapshot> {
    return await this.rpc<GlassesSnapshot>('status')
  }

  async sendText(text: string): Promise<void> {
    await this.rpc('sendText', { text })
  }

  async clear(): Promise<void> {
    await this.rpc('clear')
  }

  async sendBmp(bmpB64: string): Promise<void> {
    // Bigger timeout — BMP transfer is 400+ packets × 5ms + two L+R acks.
    await this.rpc('sendBmp', { bmp: bmpB64 }, 30_000)
  }

  /**
   * Push a card and return the `msgId` it was pushed under. The hub allocates
   * the id (rather than the APK inventing one from the wall clock) precisely so
   * the caller can dismiss this card later with [dismissNotification] — a
   * pushed card otherwise lingers on the lens with nothing able to name it.
   */
  async notify(n: GlassesNotifyRequest): Promise<{ msgId: number }> {
    const msgId = this.allocMsgId()
    await this.rpc('notify', { ...n, msgId })
    return { msgId }
  }

  /**
   * Clear a card pushed by [notify] (0x4C). The firmware acks unconditionally,
   * so this resolving does NOT prove a card with that id was on screen.
   */
  async dismissNotification(msgId: number): Promise<void> {
    await this.rpc('notifyDismiss', { msgId })
  }

  /** What's on the lens right now (0x39). Costs a BLE round trip. */
  async systemStatus(timeoutMs = 5_000): Promise<{ runningApp: number | null; idle: boolean | null }> {
    return await this.rpc('systemStatus', {}, timeoutMs)
  }

  /**
   * Make the glasses forget the bond (0x47) and drop the phone's saved pair.
   * HUMAN-ONLY — recovery needs the physical case, so the route requires an
   * explicit confirm and the CLI a `--confirm` flag.
   */
  async unpairGlasses(): Promise<void> {
    await this.rpc('unpairGlasses', { confirm: true })
  }

  async setMic(active: boolean): Promise<void> {
    await this.rpc('setMic', { active })
  }

  /** Push the head-up tilt threshold (degrees, 0..60) to both arms at runtime. */
  async setHeadUpAngle(deg: number): Promise<void> {
    await this.rpc('setHeadUpAngle', { deg })
  }

  // --- Native navigation card (0x0A) ---------------------------------------
  async navStart(): Promise<GlassesNavAck> {
    return await this.rpc<GlassesNavAck>('navStart')
  }

  async navStep(step: GlassesNavStep): Promise<GlassesNavAck> {
    return await this.rpc<GlassesNavAck>('navStep', { ...step })
  }

  async navArrived(status: 1 | 2, prompt: string): Promise<GlassesNavAck> {
    return await this.rpc<GlassesNavAck>('navArrived', { status, prompt })
  }

  async navExit(): Promise<GlassesNavAck> {
    return await this.rpc<GlassesNavAck>('navExit')
  }

  /** Two 1-bpp planes (overview 4624 B / panoramic 16592 B), base64. Chunked + RLE'd APK-side. */
  async navMap(panoramic: boolean, planesB64: string): Promise<GlassesNavAck> {
    return await this.rpc<GlassesNavAck>('navMap', { panoramic, planes: planesB64 }, 30_000)
  }

  async disconnect(): Promise<void> {
    await this.rpc('disconnect')
  }

  async startScan(durationMs = 15_000): Promise<void> {
    await this.rpc('startScan', { durationMs })
  }

  async stopScan(): Promise<void> {
    await this.rpc('stopScan')
  }

  /** Snapshot of recent observed advertisements during scans (oldest first). */
  getScanObservations(): GlassesScanObservation[] {
    return [...this.scanObservations]
  }

  /**
   * Toggle verbose research-mode frame forwarding on the APK. When verbose,
   * heartbeat frames are also shipped to the research log; otherwise only
   * touch / ack / unhandled frames are forwarded (audio is never).
   */
  async setResearch(verbose: boolean): Promise<{ verbose: boolean }> {
    return await this.rpc('setResearch', { verbose })
  }

  /** Read the last N entries from the research log (empty array if none). */
  tailResearchLog(n: number): ResearchFrame[] {
    return this.researchLog?.tail(n) ?? []
  }
}
