import { create } from 'zustand'
import type { SyncStatus } from '@/gmail/sync'
import type { MatrixSyncStatus } from '@/matrix/sync'

export type ActivePane = 'email' | 'chat' | 'bookmarks' | 'notes' | 'agents' | 'feeds' | 'calendar' | 'money'

const PANE_PATHS: Record<ActivePane, string> = {
  email: '/mail',
  chat: '/chat',
  bookmarks: '/bookmarks',
  notes: '/notes',
  agents: '/agents',
  feeds: '/feeds',
  calendar: '/calendar',
  money: '/money',
}

const PATH_PANES: Record<string, ActivePane> = {
  '/mail': 'email',
  '/chat': 'chat',
  '/bookmarks': 'bookmarks',
  '/notes': 'notes',
  '/agents': 'agents',
  '/feeds': 'feeds',
  '/calendar': 'calendar',
  '/money': 'money',
}

function paneFromUrl(): ActivePane {
  if (typeof window === 'undefined') return 'email'
  const pane = PATH_PANES[window.location.pathname] ?? 'email'
  // Initialize notification state
  import('@/notifications').then(({ setActiveNotificationPane, setDoNotDisturb }) => {
    setActiveNotificationPane(pane)
    if (localStorage.getItem('console_dnd') === 'true') setDoNotDisturb(true)
  }).catch(() => {})
  return pane
}

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

  // Active pane (email vs chat)
  activePane: ActivePane
  setActivePane: (pane: ActivePane) => void
  toggleActivePane: (reverse?: boolean) => void

  // Panels
  showSearch: boolean
  showKeybindingHelp: boolean
  showSnoozePicker: boolean
  showSchedulePicker: boolean
  showCompose: boolean // new compose (not reply)
  showMatrixLogin: boolean
  showAccountModal: boolean
  setShowSearch: (v: boolean) => void
  setShowKeybindingHelp: (v: boolean) => void
  setShowSnoozePicker: (v: boolean) => void
  setShowSchedulePicker: (v: boolean) => void
  setShowCompose: (v: boolean) => void
  setShowMatrixLogin: (v: boolean) => void
  setShowAccountModal: (v: boolean) => void

  // Sync
  syncStatus: SyncStatus
  syncDetail: string
  matrixSyncStatus: MatrixSyncStatus
  matrixSyncDetail: string
  queueCount: number
  setSyncStatus: (status: SyncStatus, detail?: string) => void
  setMatrixSyncStatus: (status: MatrixSyncStatus, detail?: string) => void
  setQueueCount: (count: number) => void

  // Undo
  undoAction: UndoAction | null
  setUndoAction: (action: UndoAction | null) => void

  // Notifications
  doNotDisturb: boolean
  setDoNotDisturb: (v: boolean) => void

  // PiP
  pipVideo: { youtubeId: string; title: string } | null
  setPipVideo: (v: { youtubeId: string; title: string } | null) => void

  // Auth
  userEmail: string
  setUserEmail: (email: string) => void
  needsReAuth: boolean
  setNeedsReAuth: (v: boolean) => void
  matrixUserId: string
  setMatrixUserId: (userId: string) => void
}

// PiP is managed by user action (play/close) — tab switches don't affect it

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

  activePane: paneFromUrl(),
  setActivePane: (pane) => {
    history.replaceState(null, '', PANE_PATHS[pane])
    import('@/notifications').then(({ setActiveNotificationPane }) => setActiveNotificationPane(pane))
    set({ activePane: pane })
  },
  toggleActivePane: (reverse) => set((s) => {
    const order: ActivePane[] = ['email', 'calendar', 'chat', 'agents', 'feeds', 'notes', 'bookmarks', 'money']
    const idx = order.indexOf(s.activePane)
    const next = order[(idx + (reverse ? order.length - 1 : 1)) % order.length]!
    history.replaceState(null, '', PANE_PATHS[next])
    import('@/notifications').then(({ setActiveNotificationPane }) => setActiveNotificationPane(next))
    return { activePane: next }
  }),

  showSearch: false,
  showKeybindingHelp: false,
  showSnoozePicker: false,
  showSchedulePicker: false,
  showCompose: false,
  showMatrixLogin: false,
  showAccountModal: false,
  setShowSearch: (v) => set({ showSearch: v }),
  setShowKeybindingHelp: (v) => set({ showKeybindingHelp: v }),
  setShowSnoozePicker: (v) => set({ showSnoozePicker: v }),
  setShowSchedulePicker: (v) => set({ showSchedulePicker: v }),
  setShowCompose: (v) => set({ showCompose: v }),
  setShowMatrixLogin: (v) => set({ showMatrixLogin: v }),
  setShowAccountModal: (v) => set({ showAccountModal: v }),

  syncStatus: 'idle',
  syncDetail: '',
  matrixSyncStatus: 'idle',
  matrixSyncDetail: '',
  queueCount: 0,
  setSyncStatus: (status, detail) => set({ syncStatus: status, syncDetail: detail ?? '' }),
  setMatrixSyncStatus: (status, detail) => set({ matrixSyncStatus: status, matrixSyncDetail: detail ?? '' }),
  setQueueCount: (count) => set({ queueCount: count }),

  undoAction: null,
  setUndoAction: (action) => set({ undoAction: action }),

  pipVideo: null,
  setPipVideo: (v) => set({ pipVideo: v }),

  doNotDisturb: typeof localStorage !== 'undefined' && localStorage.getItem('console_dnd') === 'true',
  setDoNotDisturb: (v) => {
    localStorage.setItem('console_dnd', String(v))
    import('@/notifications').then(({ setDoNotDisturb }) => setDoNotDisturb(v))
    set({ doNotDisturb: v })
  },

  userEmail: '',
  setUserEmail: (email) => set({ userEmail: email }),
  needsReAuth: false,
  setNeedsReAuth: (v) => set({ needsReAuth: v }),
  matrixUserId: '',
  setMatrixUserId: (userId) => set({ matrixUserId: userId }),
}))

// Sync URL → store on back/forward navigation
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    useUiStore.setState({ activePane: paneFromUrl() })
  })
}
