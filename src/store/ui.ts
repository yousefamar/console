import { create } from 'zustand'
import type { SyncStatus } from '@/gmail/sync'
import type { MatrixSyncStatus } from '@/matrix/sync'
import { getPref, setPref } from '@/prefs'

export type ActivePane = 'home' | 'email' | 'chat' | 'bookmarks' | 'notes' | 'agents' | 'feeds' | 'calendar' | 'map' | 'money'

const PANE_PATHS: Record<ActivePane, string> = {
  home: '/',
  email: '/mail',
  chat: '/chat',
  bookmarks: '/bookmarks',
  notes: '/notes',
  agents: '/agents',
  feeds: '/feeds',
  calendar: '/calendar',
  map: '/map',
  money: '/money',
}

const PATH_PANES: Record<string, ActivePane> = {
  '/': 'home',
  '/mail': 'email',
  '/chat': 'chat',
  '/bookmarks': 'bookmarks',
  '/notes': 'notes',
  '/agents': 'agents',
  '/feeds': 'feeds',
  '/calendar': 'calendar',
  '/map': 'map',
  '/money': 'money',
}

function paneFromUrl(): ActivePane {
  if (typeof window === 'undefined') return 'home'
  const pane = PATH_PANES[window.location.pathname] ?? 'home'
  // Initialize notification state. DnD is applied in App init once hub prefs
  // have loaded — don't touch it here, to avoid a race with the async fetch.
  import('@/notifications').then(({ setActiveNotificationPane }) => {
    setActiveNotificationPane(pane)
  }).catch(() => {})
  return pane
}

interface UndoAction {
  label: string
  undo: () => Promise<void>
  expiresAt: number
}

export interface DialogState {
  id: number
  kind: 'alert' | 'confirm' | 'prompt'
  title?: string
  message: string
  /** prompt-only */
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  /** confirm — red OK button */
  danger?: boolean
  /** internal: resolve the awaiting promise */
  resolve: (value: unknown) => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
  /** Optional second line / details */
  detail?: string
  /** Optional URL to open on click */
  href?: string
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
  /** Hub WebSocket connection state. False off-tailnet or while the hub
   *  process is down. Mutations still enqueue (sync-queue) and flush on
   *  reconnect; the offline pill in the header surfaces this to the user. */
  hubOnline: boolean
  setSyncStatus: (status: SyncStatus, detail?: string) => void
  setMatrixSyncStatus: (status: MatrixSyncStatus, detail?: string) => void
  setQueueCount: (count: number) => void
  setHubOnline: (online: boolean) => void

  // Undo
  undoAction: UndoAction | null
  setUndoAction: (action: UndoAction | null) => void
  toasts: Toast[]
  pushToast: (toast: Omit<Toast, 'id' | 'expiresAt'> & { ttlMs?: number }) => void
  dismissToast: (id: number) => void
  dialog: DialogState | null
  setDialog: (d: DialogState | null) => void

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
    const order: ActivePane[] = ['home', 'email', 'calendar', 'chat', 'agents', 'feeds', 'notes', 'bookmarks', 'map', 'money']
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
  // Optimistic default — flips to false on the first onDisconnect, or stays
  // true once `hubBus.onConnect` fires. The bridge is wired in App init.
  hubOnline: true,
  setSyncStatus: (status, detail) => set({ syncStatus: status, syncDetail: detail ?? '' }),
  setMatrixSyncStatus: (status, detail) => set({ matrixSyncStatus: status, matrixSyncDetail: detail ?? '' }),
  setQueueCount: (count) => set({ queueCount: count }),
  setHubOnline: (online) => set({ hubOnline: online }),

  undoAction: null,
  setUndoAction: (action) => set({ undoAction: action }),
  toasts: [],
  pushToast: (toast) => {
    const id = Date.now() + Math.floor(Math.random() * 1000)
    const ttl = toast.ttlMs ?? (toast.kind === 'error' ? 8000 : 4000)
    const next: Toast = {
      id,
      kind: toast.kind,
      message: toast.message,
      detail: toast.detail,
      href: toast.href,
      expiresAt: Date.now() + ttl,
    }
    set((s) => ({ toasts: [...s.toasts, next] }))
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dialog: null,
  setDialog: (d) => set({ dialog: d }),

  pipVideo: null,
  setPipVideo: (v) => set({ pipVideo: v }),

  // Default to the value loaded into hub prefs on boot; App init fetches and
  // re-applies after initPrefs() resolves.
  doNotDisturb: getPref<boolean>('dnd', false),
  setDoNotDisturb: (v) => {
    setPref('dnd', v)
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
