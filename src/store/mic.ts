import { create } from 'zustand'
import { hubBus } from '@/sync-bus'

// Push-to-talk mic ownership, mirrored from the hub SyncBus 'mic' service.
// `owner` is a hub session id (matches SessionInfo.id); default owner is Al.
// `hot` = the owner is actively recording. The hub pushes a 'state' event on
// every change (owner reassignment AND hot on/off); we also re-fetch on connect.

interface MicSnapshot { owner: string | null; ownerName: string | null; hot: boolean }

interface MicState extends MicSnapshot {
  wired: boolean
  // Review-mode dictation: a finished PTT utterance the hub wants dropped into
  // the owner session's composer UNSENT (vs /mic/say which auto-sends). The
  // composer (AgentPromptInput) reacts to `composeSeq` — a monotonic counter so
  // even an identical transcript re-triggers — and fills its textarea.
  composeOwner: string | null
  composeText: string
  composeSeq: number
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
  composeOwner: null,
  composeText: '',
  composeSeq: 0,

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
    hubBus.on('mic', 'compose', (data) => {
      const d = (data ?? {}) as { owner?: string | null; text?: string }
      if (!d.text) return
      set((s) => ({ composeOwner: d.owner ?? null, composeText: d.text ?? '', composeSeq: s.composeSeq + 1 }))
    })
    hubBus.onConnect(() => fetchStatus()) // re-sync after a (re)connect
    fetchStatus()
  },

  setMic: (target) => {
    hubBus.rpc('mic', 'set', { target }).catch((e) => console.error('[mic] set failed:', e))
  },
}))
