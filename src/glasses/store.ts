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
} from './bridge'
import {
  loadEnabled as loadMirrorEnabled,
  setEnabled as setMirrorEnabledPersist,
  pushMirrorNow,
  isEnabled as isMirrorEnabled,
} from './notes-mirror'
import { setNotesMirrorDim } from './bridge'
import { useNotesStore } from '@/store/notes'

interface GlassesStore {
  supported: boolean
  snapshot: GlassesSnapshot | null
  scanning: boolean
  candidates: ScanCandidate[]
  notesMirrorEnabled: boolean

  refresh: () => void
  setScanning: (v: boolean) => void
  startScan: (durationMs?: number) => void
  stopScan: () => void
  setNotesMirrorEnabled: (v: boolean) => void
}

export const useGlassesStore = create<GlassesStore>((set, get) => ({
  supported: glassesSupported(),
  snapshot: getStatus(),
  scanning: false,
  candidates: getScanCandidates(),
  notesMirrorEnabled: loadMirrorEnabled(),

  refresh: () => {
    set({ snapshot: getStatus(), candidates: getScanCandidates() })
  },

  setScanning: (v) => set({ scanning: v }),

  startScan: (durationMs = 15_000) => {
    if (!get().supported) return
    set({ scanning: true, candidates: [] })
    bridgeStartScan(durationMs)
    // Auto-clear the flag after duration + 500ms slack. Native side stops
    // scanning on its own timer.
    window.setTimeout(() => {
      set({ scanning: false })
      // Pick up any last-second candidates the native side logged.
      set({ candidates: getScanCandidates() })
    }, durationMs + 500)
  },

  stopScan: () => {
    bridgeStopScan()
    set({ scanning: false })
  },

  setNotesMirrorEnabled: (v) => {
    setMirrorEnabledPersist(v)
    set({ notesMirrorEnabled: v })
    // When turning on, immediately push whatever the active editor is
    // showing so the user sees context without having to type first.
    if (v) {
      const view = useNotesStore.getState().editorView
      if (view) pushMirrorNow(view.state)
    }
  },
}))

// Subscribe once to the native state-change stream. Called from main.tsx.
let wired = false
export function wireGlassesStore() {
  if (wired) return
  wired = true
  if (!glassesSupported()) return
  // Re-apply the persisted notes-mirror dim state so a cold-start with the
  // toggle already on keeps the screen alive for HW keyboard input.
  if (isMirrorEnabled()) setNotesMirrorDim(true)
  onStateChange((snap) => {
    useGlassesStore.setState({ snapshot: snap, candidates: getScanCandidates() })
  })
}
