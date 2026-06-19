import { create } from 'zustand'
import { hubBus } from '@/sync-bus'

// Push-to-talk mic ownership, mirrored from the hub SyncBus 'mic' service.
// `owner` is a hub session id (matches SessionInfo.id); default owner is Al.
// `hot` = the owner is actively recording. The hub pushes a 'state' event on
// every change (owner reassignment AND hot on/off); we also re-fetch on connect.

interface MicSnapshot { owner: string | null; ownerName: string | null; hot: boolean }

interface MicState extends MicSnapshot {
  wired: boolean
  /** Subscribe to the hub 'mic' service + fetch the current owner. Idempotent. */
  init: () => void
  /** Hand the mic to a target (session id / name / agentKey; 'al' resets to Al). */
  setMic: (target: string) => void
}

export const useMicStore = create<MicState>((set, get) => ({
  owner: null,
  ownerName: null,
  hot: false,
  wired: false,

  init: () => {
    if (get().wired) return
    set({ wired: true })
    const fetchStatus = () => {
      hubBus.rpc<MicSnapshot>('mic', 'status', {})
        .then((s) => set({ owner: s.owner ?? null, ownerName: s.ownerName ?? null, hot: !!s.hot }))
        .catch(() => {})
    }
    hubBus.on('mic', 'state', (data) => {
      const d = (data ?? {}) as Partial<MicSnapshot>
      set({ owner: d.owner ?? null, ownerName: d.ownerName ?? null, hot: !!d.hot })
    })
    hubBus.onConnect(() => fetchStatus()) // re-sync after a (re)connect
    fetchStatus()
  },

  setMic: (target) => {
    hubBus.rpc('mic', 'set', { target }).catch((e) => console.error('[mic] set failed:', e))
  },
}))
