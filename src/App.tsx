import { useState, useEffect } from 'react'
import { initAuth, signIn, isSignedIn, onAuthExpired } from '@/gmail/auth'
import { resetStuckProcessing } from '@/db/sync-queue'
import { isMatrixConnected, initMatrixAuth } from '@/matrix/auth'
import { getHubUrl } from '@/hub'
import { initPrefs, getPref } from '@/prefs'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useSync } from '@/hooks/useSync'
import { useUiStore } from '@/store/ui'
import { useNotesStore } from '@/store/notes'
import { useInboxStore } from '@/store/inbox'
import { Layout } from '@/components/Layout'
import { SnoozePicker } from '@/components/SnoozePicker'
import { SearchOverlay } from '@/components/SearchOverlay'
import { KeybindingHelp } from '@/components/KeybindingHelp'
import { UndoToast } from '@/components/UndoToast'
import { ComposeEditor } from '@/components/ComposeEditor'
import { MatrixLoginModal } from '@/components/MatrixLoginModal'
import { AccountModal } from '@/components/AccountModal'

// Shown when hub can't provide a token (rare — user revoked access).
function ReAuthBanner() {
  const [loading, setLoading] = useState(false)
  const setNeedsReAuth = useUiStore((s) => s.setNeedsReAuth)

  async function handleReAuth() {
    const popup = window.open(
      `${getHubUrl()}/auth/google/start`,
      'google-auth',
      'width=500,height=600,menubar=no,toolbar=no',
    )
    setLoading(true)
    try {
      await signIn(popup)
      setNeedsReAuth(false)
    } catch {
      // User cancelled the popup
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 bg-amber-600 px-4 py-1.5 text-sm text-white">
      <span>Session expired — please sign in again</span>
      <button
        onClick={handleReAuth}
        disabled={loading}
        className="rounded-sm bg-white/20 px-3 py-0.5 text-xs font-medium hover:bg-white/30 disabled:opacity-50"
      >
        {loading ? 'Connecting...' : 'Sign in with Google'}
      </button>
    </div>
  )
}

function hasUnsavedWork(): boolean {
  // Dirty notes
  const { openFiles } = useNotesStore.getState()
  for (const file of Object.values(openFiles)) {
    if (file.content !== file.savedContent) return true
  }
  // Open compose or reply
  if (useUiStore.getState().showCompose) return true
  if (useInboxStore.getState().replyMode) return true
  // Pending sync queue
  if (useUiStore.getState().queueCount > 0) return true
  // Typing in agent prompt input
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.value) return true
  return false
}

function ConsoleApp() {
  useKeybindings()
  useSync()

  // Ask for notification permission when needed. requestPermission() no-ops
  // when the browser has already recorded a decision; it only triggers the
  // UI prompt while permission is still 'default'. Previously gated by a
  // localStorage flag that stuck after the browser reset permission (e.g.
  // Brave's inactivity revocation) — meant we never re-prompted and every
  // desktop notification was silently dropped.
  useEffect(() => {
    import('@/notifications').then(({ requestPermission }) => {
      void requestPermission()
    })
  }, [])

  // Warn before closing with unsaved work
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedWork()) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])


  const showSearch = useUiStore((s) => s.showSearch)
  const showKeybindingHelp = useUiStore((s) => s.showKeybindingHelp)
  const showSnoozePicker = useUiStore((s) => s.showSnoozePicker)
  const showCompose = useUiStore((s) => s.showCompose)
  const setShowCompose = useUiStore((s) => s.setShowCompose)
  const showMatrixLogin = useUiStore((s) => s.showMatrixLogin)
  const showAccountModal = useUiStore((s) => s.showAccountModal)
  const needsReAuth = useUiStore((s) => s.needsReAuth)

  return (
    <>
      {needsReAuth && <ReAuthBanner />}
      <Layout />
      {showSearch && <SearchOverlay />}
      {showKeybindingHelp && <KeybindingHelp />}
      {showSnoozePicker && <SnoozePicker />}
      {showCompose && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCompose(false)} />
          <div className="relative z-10 w-full max-w-2xl md:mb-4 rounded-t-md md:rounded-sm border border-border bg-surface-1 shadow-lg">
            <ComposeEditor mode="compose" onClose={() => setShowCompose(false)} />
          </div>
        </div>
      )}
      {showMatrixLogin && <MatrixLoginModal />}
      {showAccountModal && <AccountModal />}
      <UndoToast />
    </>
  )
}

export function App() {
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Reset any queue items stuck in 'processing' from a previous session.
    resetStuckProcessing()

    // Hydrate UI state from cached identity metadata synchronously so the
    // first render already reflects the last-known session. Matrix userId and
    // Gmail signedIn/email are persisted in localStorage by their respective
    // auth modules; reading them here is free and offline-safe.
    const cachedMatrixUserId = localStorage.getItem('matrix_user_id')
    if (cachedMatrixUserId) {
      useUiStore.getState().setMatrixUserId(cachedMatrixUserId)
    }

    // Release the loading screen immediately — offline-first means the UI
    // must render from IndexedDB without waiting for the hub. All hub calls
    // below run in the background and update state when (if) they return.
    setLoading(false)

    // Background refresh: ask the hub for the latest prefs + auth status.
    // None of these gate rendering; if the hub is unreachable the cached
    // state (localStorage + IDB) stays in effect.
    void initPrefs().then(() => {
      if (getPref('dnd', false)) {
        void import('@/notifications').then(({ setDoNotDisturb }) => setDoNotDisturb(true))
        useUiStore.setState({ doNotDisturb: true })
      }
      const expandedDirs = getPref<string[]>('notesExpandedDirs', [])
      if (expandedDirs.length > 0) {
        void import('@/store/notes').then(({ useNotesStore }) => {
          useNotesStore.setState({ expandedDirs: new Set(expandedDirs) })
        })
      }
    })

    void initAuth().then(() => {
      if (isSignedIn()) {
        fetch(`${getHubUrl()}/auth/status`)
          .then(async (res) => {
            if (!res.ok) return
            const status = await res.json() as { google: { accounts: Array<{ email: string; isPrimary: boolean }> } }
            const primary = status.google.accounts.find((a) => a.isPrimary) ?? status.google.accounts[0]
            if (primary) useUiStore.getState().setUserEmail(primary.email)
          })
          .catch(() => {})
      }
    }).catch(() => {})

    void initMatrixAuth().then(() => {
      if (isMatrixConnected()) {
        const matrixUserId = localStorage.getItem('matrix_user_id')
        if (matrixUserId) useUiStore.getState().setMatrixUserId(matrixUserId)
      }
    }).catch(() => {})
  }, [])

  // Listen for auth expiry (refresh token dead — very rare)
  useEffect(() => {
    return onAuthExpired(() => {
      useUiStore.getState().setNeedsReAuth(true)
    })
  }, [])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-0">
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    )
  }

  return <ConsoleApp />
}
