import { create } from 'zustand'
import type { SyncStatus } from '@/gmail/sync'

interface UndoAction {
  label: string
  undo: () => Promise<void>
  expiresAt: number
}

interface UiState {
  // Theme
  darkMode: boolean
  emailDarkMode: boolean // separate toggle for email iframe dark mode
  toggleDarkMode: () => void
  toggleEmailDarkMode: () => void

  // Panels
  showSearch: boolean
  showKeybindingHelp: boolean
  showSnoozePicker: boolean
  showSchedulePicker: boolean
  showCompose: boolean // new compose (not reply)
  setShowSearch: (v: boolean) => void
  setShowKeybindingHelp: (v: boolean) => void
  setShowSnoozePicker: (v: boolean) => void
  setShowSchedulePicker: (v: boolean) => void
  setShowCompose: (v: boolean) => void

  // Sync
  syncStatus: SyncStatus
  syncDetail: string
  queueCount: number
  setSyncStatus: (status: SyncStatus, detail?: string) => void
  setQueueCount: (count: number) => void

  // Undo
  undoAction: UndoAction | null
  setUndoAction: (action: UndoAction | null) => void

  // Auth
  userEmail: string
  setUserEmail: (email: string) => void
  needsReAuth: boolean
  setNeedsReAuth: (v: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  darkMode: true,
  emailDarkMode: true,
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode
      document.documentElement.classList.toggle('dark', next)
      return { darkMode: next }
    }),
  toggleEmailDarkMode: () => set((s) => ({ emailDarkMode: !s.emailDarkMode })),

  showSearch: false,
  showKeybindingHelp: false,
  showSnoozePicker: false,
  showSchedulePicker: false,
  showCompose: false,
  setShowSearch: (v) => set({ showSearch: v }),
  setShowKeybindingHelp: (v) => set({ showKeybindingHelp: v }),
  setShowSnoozePicker: (v) => set({ showSnoozePicker: v }),
  setShowSchedulePicker: (v) => set({ showSchedulePicker: v }),
  setShowCompose: (v) => set({ showCompose: v }),

  syncStatus: 'idle',
  syncDetail: '',
  queueCount: 0,
  setSyncStatus: (status, detail) => set({ syncStatus: status, syncDetail: detail ?? '' }),
  setQueueCount: (count) => set({ queueCount: count }),

  undoAction: null,
  setUndoAction: (action) => set({ undoAction: action }),

  userEmail: '',
  setUserEmail: (email) => set({ userEmail: email }),
  needsReAuth: false,
  setNeedsReAuth: (v) => set({ needsReAuth: v }),
}))
