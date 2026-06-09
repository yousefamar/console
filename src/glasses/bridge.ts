// Adapter over the Android `ConsoleNative` JS bridge (see
// android/app/src/main/kotlin/io/amar/console/MainActivity.kt → `ConsoleBridge`).
//
// All functions are no-ops / return null in the PWA (desktop/mobile web) — the
// G1 link is owned exclusively by the APK process. The hub and CLI reach
// glasses *through* the phone; see docs/g1-protocol.md for the overall topology.

declare global {
  interface Window {
    ConsoleNative?: {
      glassesStatus?: () => string
      glassesScanCandidates?: () => string
      glassesScan?: (durationMs: number) => void
      glassesStopScan?: () => void
      glassesPair?: (leftMac: string, rightMac: string, channel: string) => void
      glassesUnpair?: () => void
      glassesDisconnect?: () => void
      glassesSendText?: (text: string) => void
      glassesClear?: () => void
      glassesSendBmp?: (bmpB64: string) => void
      glassesNotify?: (json: string) => void
      glassesStartMic?: () => void
      glassesStopMic?: () => void
      /**
       * Toggle "stealth screen" mode: screen appears off (brightness ~0)
       * but Activity stays foreground so HW keyboard events keep flowing.
       * Used by the app-wide mirror so the user can interact with the
       * phone dark and read only the lenses. APK v17+.
       * The old `setNotesMirrorDim` name is kept as a fallback for the
       * brief window while users are still on v12..v16.
       */
      setMirrorDim?: (enabled: boolean) => void
      setNotesMirrorDim?: (enabled: boolean) => void
      // Hub bearer token bridge (APK v20+). Set is called by AccountModal's
      // "Pair this APK" action; has/clear let the SPA reflect current state.
      setHubToken?: (token: string) => void
      hasHubToken?: () => boolean
      clearHubToken?: () => void
    }
  }
}

function bridge() {
  return (typeof window !== 'undefined' && window.ConsoleNative) || undefined
}

export type ArmStatus = 'disconnected' | 'connecting' | 'connected'

export interface ArmSnapshot {
  status: ArmStatus
  mac: string | null
  battery: number | null
  /** True when the arm is sitting on its case charging pin (from `0xF5 0x09`). */
  charging: boolean | null
  serial: string | null
}

export interface GlassesSnapshot {
  connected: boolean
  left: ArmSnapshot
  right: ArmSnapshot
  channel: string | null
  micActive: boolean
  /** True when on-head, false when taken off, null if wear detection is
   *  silent (glasses haven't reported, or it's disabled firmware-side). */
  worn: boolean | null
  /** Charging-case battery % 0..100, reported via 0xF5 subcmd 0x0F. */
  caseBattery: number | null
  /** Whether the charging case is currently plugged in; 0xF5 subcmd 0x0E. */
  caseCharging: boolean | null
  lastError: string | null
  lastUpdatedMs: number
}

export interface ScanCandidate {
  channel: string
  leftMac: string | null
  rightMac: string | null
  rssi: number | null
  ready: boolean
}

export interface GlassesNotification {
  appIdentifier: string
  title: string
  subtitle: string
  message: string
  /** Unix ms; defaults to now() native-side if omitted. */
  timestamp?: number
}

/**
 * Glasses support is only available inside the APK shell.
 *
 * We check `window.ConsoleNative` (installed via `addJavascriptInterface`,
 * present from the first JS tick) rather than `isNative()` (which reads
 * `window.__isConsoleAPK`, set later in `onPageFinished`). The bridge is
 * the authoritative signal and avoids a boot-order race where modules
 * evaluated during initial render saw `isNative() === false`.
 */
export function glassesSupported(): boolean {
  return !!bridge()
}

export function getStatus(): GlassesSnapshot | null {
  const b = bridge()
  if (!b?.glassesStatus) return null
  try {
    return JSON.parse(b.glassesStatus()) as GlassesSnapshot
  } catch {
    return null
  }
}

export function getScanCandidates(): ScanCandidate[] {
  const b = bridge()
  if (!b?.glassesScanCandidates) return []
  try {
    return JSON.parse(b.glassesScanCandidates()) as ScanCandidate[]
  } catch {
    return []
  }
}

export function startScan(durationMs = 15_000): void {
  bridge()?.glassesScan?.(durationMs)
}

export function stopScan(): void {
  bridge()?.glassesStopScan?.()
}

export function pair(leftMac: string, rightMac: string, channel: string): void {
  bridge()?.glassesPair?.(leftMac, rightMac, channel)
}

export function unpair(): void {
  bridge()?.glassesUnpair?.()
}

/** Sever the BLE link without forgetting the saved pair (DND-style). */
export function disconnect(): void {
  bridge()?.glassesDisconnect?.()
}

export function sendText(text: string): void {
  bridge()?.glassesSendText?.(text)
}

export function clear(): void {
  bridge()?.glassesClear?.()
}

/** `bmpB64` must be raw bytes of a 576×136 1-bpp BMP, base64-encoded. */
export function sendBmp(bmpB64: string): void {
  bridge()?.glassesSendBmp?.(bmpB64)
}

export function sendNotification(n: GlassesNotification): void {
  bridge()?.glassesNotify?.(JSON.stringify(n))
}

export function startMic(): void {
  bridge()?.glassesStartMic?.()
}

export function stopMic(): void {
  bridge()?.glassesStopMic?.()
}

/**
 * Ask the APK to enter "stealth screen" — keep the Activity alive and
 * receiving HW keyboard input, but set screen brightness to ~0 so the
 * panel is visually dark. Used by the app-wide mirror. No-op in browser.
 * Prefers the new `setMirrorDim` bridge (APK v17+) but falls back to
 * `setNotesMirrorDim` so v12..v16 installs keep working.
 */
export function setMirrorDim(enabled: boolean): void {
  const b = bridge()
  if (b?.setMirrorDim) b.setMirrorDim(enabled)
  else b?.setNotesMirrorDim?.(enabled)
}

// --- Native → Web events -----------------------------------------------------
//
// `MainActivity.emitGlassesState()` dispatches `console:glasses:state` on
// every state mutation. `emitGlassesEvent(name, detail)` dispatches
// `console:glasses:event` for transient events like touchbar taps.

export function onStateChange(fn: (snap: GlassesSnapshot) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = () => {
    const s = getStatus()
    if (s) fn(s)
  }
  window.addEventListener('console:glasses:state', handler)
  return () => window.removeEventListener('console:glasses:state', handler)
}

export interface GlassesEvent {
  name: string
  detail: unknown
}

export function onEvent(fn: (ev: GlassesEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => {
    const ce = e as CustomEvent<GlassesEvent>
    if (ce.detail) fn(ce.detail)
  }
  window.addEventListener('console:glasses:event', handler)
  return () => window.removeEventListener('console:glasses:event', handler)
}
