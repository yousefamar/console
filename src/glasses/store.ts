import { create } from 'zustand'
import {
  getStatus,
  getScanCandidates,
  onStateChange,
  type GlassesSnapshot,
  type ScanCandidate,
  glassesSupported,
  startScan as bridgeStartScan,
  stopScan as bridgeStopScan,
  reconnect as bridgeReconnect,
  disconnect as bridgeDisconnect,
  pair as bridgePair,
  unpair as bridgeUnpair,
  setMirrorDim,
} from './bridge'
import {
  loadEnabled as loadMirrorEnabled,
  setEnabled as setMirrorEnabledPersist,
  isEnabled as isMirrorEnabled,
  scheduleFrame,
  wireMirror,
} from './mirror'

type ComposerPane = 'chat' | 'agents'

interface GlassesStore {
  supported: boolean
  snapshot: GlassesSnapshot | null
  scanning: boolean
  candidates: ScanCandidate[]
  mirrorEnabled: boolean

  /** Live text the user is typing in the pane composer — mirrored to row 5
   *  of the glasses for Chat/Agents. Uncontrolled textareas push here on
   *  every keystroke (the React tree doesn't re-render, just the mirror). */
  composerText: { chat: string; agents: string }

  refresh: () => void
  setScanning: (v: boolean) => void
  startScan: (durationMs?: number) => void
  stopScan: () => void
  /** Reconnect the already-saved L/R pair (no scan) — the primary action. */
  connect: () => void
  /** Sever the BLE link, keeping the saved pair (DND-style). */
  disconnect: () => void
  /** Pair (and connect) a freshly-scanned L/R candidate. */
  pair: (leftMac: string, rightMac: string, channel: string) => void
  /** Forget the saved pair. */
  unpair: () => void
  setMirrorEnabled: (v: boolean) => void
  setComposerText: (pane: ComposerPane, text: string) => void
  /** Trigger a mirror re-render when state changed outside Zustand (async
   *  Dexie fetches, etc.). */
  bumpMirror: () => void
}

export const useGlassesStore = create<GlassesStore>((set, get) => ({
  supported: glassesSupported(),
  snapshot: getStatus(),
  scanning: false,
  candidates: getScanCandidates(),
  mirrorEnabled: loadMirrorEnabled(),
  composerText: { chat: '', agents: '' },

  refresh: () => {
    set({ snapshot: getStatus(), candidates: getScanCandidates() })
  },

  setScanning: (v) => set({ scanning: v }),

  startScan: (durationMs = 15_000) => {
    if (!get().supported) return
    set({ scanning: true, candidates: [] })
    bridgeStartScan(durationMs)
    window.setTimeout(() => {
      set({ scanning: false, candidates: getScanCandidates() })
    }, durationMs + 500)
  },

  stopScan: () => {
    bridgeStopScan()
    set({ scanning: false })
  },

  connect: () => {
    if (!get().supported) return
    bridgeReconnect()
  },

  disconnect: () => {
    bridgeDisconnect()
  },

  pair: (leftMac, rightMac, channel) => {
    bridgePair(leftMac, rightMac, channel)
  },

  unpair: () => {
    bridgeUnpair()
  },

  setMirrorEnabled: (v) => {
    setMirrorEnabledPersist(v)
    set({ mirrorEnabled: v })
  },

  setComposerText: (pane, text) => {
    const cur = get().composerText
    if (cur[pane] === text) return
    set({ composerText: { ...cur, [pane]: text } })
  },

  bumpMirror: () => {
    scheduleFrame()
  },
}))

let wired = false
export function wireGlassesStore() {
  if (wired) return
  wired = true
  if (!glassesSupported()) return
  // Re-apply the persisted stealth-screen state so a cold-start with the
  // mirror already on keeps the screen alive for HW keyboard input.
  if (isMirrorEnabled()) setMirrorDim(true)
  wireMirror()
  onStateChange((snap) => {
    useGlassesStore.setState({ snapshot: snap, candidates: getScanCandidates() })
  })
}
