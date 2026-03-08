import { useState, useEffect } from 'react'
import { initAuth, signIn, isSignedIn, onAuthExpired } from '@/gmail/auth'
import { getMeta } from '@/db'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useSync } from '@/hooks/useSync'
import { useUiStore } from '@/store/ui'
import { Layout } from '@/components/Layout'
import { AuthScreen } from '@/components/AuthScreen'
import { SnoozePicker } from '@/components/SnoozePicker'
import { SearchOverlay } from '@/components/SearchOverlay'
import { KeybindingHelp } from '@/components/KeybindingHelp'
import { UndoToast } from '@/components/UndoToast'
import { ComposeEditor } from '@/components/ComposeEditor'

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

function AuthenticatedApp() {
  useKeybindings()
  useSync()

  const showSearch = useUiStore((s) => s.showSearch)
  const showKeybindingHelp = useUiStore((s) => s.showKeybindingHelp)
  const showSnoozePicker = useUiStore((s) => s.showSnoozePicker)
  const showCompose = useUiStore((s) => s.showCompose)
  const setShowCompose = useUiStore((s) => s.setShowCompose)
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
      <UndoToast />
    </>
  )
}

export function App() {
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function tryAutoAuth() {
      try {
        await initAuth()
        if (isSignedIn()) {
          const email = await getMeta('email')
          if (email) {
            useUiStore.getState().setUserEmail(email)
          }
          setAuthenticated(true)
        }
      } catch {
        // Auth init failed
      } finally {
        setLoading(false)
      }
    }
    tryAutoAuth()
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

  if (!authenticated) {
    return <AuthScreen onAuth={() => setAuthenticated(true)} />
  }

  return <AuthenticatedApp />
}
