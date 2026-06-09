import { useEffect, useState } from 'react'
import { getHubUrl, isAuthPending, subscribeAuthPending } from '@/hub'

/**
 * Full-screen overlay shown when a hub request returned 401 with the
 * `WWW-Authenticate: ConsoleSession` challenge. Sole action: redirect the
 * top-level navigation to the hub's Google OAuth start endpoint with a
 * `?return=...` carrying the current URL, so we land back where we were
 * after sign-in.
 *
 * Mounts above every pane via Layout.tsx; nothing else renders while this
 * is up — the SPA shell behind it would just keep failing requests until
 * the session cookie is set.
 */
export function LoginScreen() {
  const [pending, setPending] = useState(isAuthPending())

  useEffect(() => subscribeAuthPending(setPending), [])

  if (!pending) return null

  const signIn = () => {
    const ret = encodeURIComponent(window.location.href)
    window.location.href = `${getHubUrl()}/auth/google/start?return=${ret}`
  }

  return (
    <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-bg-base/95 backdrop-blur-sm text-text-primary">
      <div className="w-full max-w-sm flex flex-col items-center gap-6 p-8">
        <h1 className="text-lg font-medium">Console</h1>
        <p className="text-sm text-text-tertiary text-center">
          The hub needs you to sign in before it'll trust this browser.
        </p>
        <button
          onClick={signIn}
          className="px-4 py-2 bg-surface-2 hover:bg-surface-3 border border-border rounded text-sm transition-colors"
          autoFocus
        >
          Sign in with Google
        </button>
        <p className="text-xs text-text-quaternary text-center">
          You'll be redirected back here after authenticating.
        </p>
      </div>
    </div>
  )
}
