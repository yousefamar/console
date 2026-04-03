import { useState, useEffect } from 'react'
import { initAuth, signIn, isSignedIn, onAuthExpired } from '@/gmail/auth'
import { resetStuckProcessing } from '@/db/sync-queue'
import { isMatrixConnected } from '@/matrix/auth'
import { getMeta } from '@/db'
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

// Shown only when the refresh token is dead (rare — user revoked access).
// Normal token expiry is handled silently via /api/auth/refresh.
function ReAuthBanner() {
  const [loading, setLoading] = useState(false)
  const setNeedsReAuth = useUiStore((s) => s.setNeedsReAuth)

  async function handleReAuth() {
    setLoading(true)
    try {
      await signIn()
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
  return false
}

function ConsoleApp() {
  useKeybindings()
  useSync()

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
    async function init() {
      // Reset any queue items stuck in 'processing' from a previous session
      resetStuckProcessing()

      try {
        // Try to initialize Gmail auth (non-blocking — app works without it)
        await initAuth()
        if (isSignedIn()) {
          const email = await getMeta('email')
          if (email) {
            useUiStore.getState().setUserEmail(email)
          }
        }
      } catch {
        // Gmail auth init failed — app still works for other tabs
      }

      // Initialize Matrix user ID if connected
      if (isMatrixConnected()) {
        const matrixUserId = localStorage.getItem('matrix_user_id')
        if (matrixUserId) {
          useUiStore.getState().setMatrixUserId(matrixUserId)
        }
      }

      setLoading(false)
    }
    init()
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
