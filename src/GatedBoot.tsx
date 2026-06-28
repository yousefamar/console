// Auth gate that decides what to render before any app code runs.
//
// Threat model: an unauthenticated visitor must NOT see any of the SPA's
// DOM structure — no pane tabs, no panels, no Layout chrome, no store
// data. So we don't import App, sync-bus, stores, or any pane until we
// have an authenticated session.
//
// One fetch is made pre-auth: GET /hub/auth/session. The server marks
// this path always-open in auth-middleware.ts. The response shape is
// { authenticated: false } or { authenticated: true, email, ... }.

import { useEffect, useState, lazy, Suspense } from 'react'
import { LoginScreen } from './components/LoginScreen'
import { getHubUrl } from './hub'
import { isNative } from './platform'

// One-time cleanup of stale localStorage overrides. A
// `console_hub_url` whose host doesn't match the current page's host can
// only have come from a cross-origin migration import (or a manual dev
// override against an old hostname like the retired tailnet `:9877`).
// Either way it's dead now — strip it before the gate's first /auth probe.
function purgeStaleHubOverride(): void {
  try {
    const raw = localStorage.getItem('console_hub_url')
    if (!raw) return
    const u = new URL(raw)
    const here = window.location.hostname
    // Allow loopback/localhost for dev. Otherwise host must match.
    const ok = u.hostname === here || u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (!ok) {
      localStorage.removeItem('console_hub_url')
      sessionStorage.removeItem('console_hub_legacy')
      console.warn('[gate] purged stale console_hub_url override → ' + raw)
    }
  } catch {
    localStorage.removeItem('console_hub_url')
  }
}

purgeStaleHubOverride()

const LazyApp = lazy(async () => {
  // Pull in dayjs plugins, the sync bus, glasses wiring, service worker,
  // and finally App itself. All of this is gated behind a real session
  // so an unauthenticated visitor never even downloads the chunk that
  // describes the panes.
  const dayjsPkg = await import('dayjs')
  const dayjs = dayjsPkg.default
  const [isSameOrAfter, isSameOrBefore, timezone, utc] = await Promise.all([
    import('dayjs/plugin/isSameOrAfter').then((m) => m.default),
    import('dayjs/plugin/isSameOrBefore').then((m) => m.default),
    import('dayjs/plugin/timezone').then((m) => m.default),
    import('dayjs/plugin/utc').then((m) => m.default),
  ])
  dayjs.extend(isSameOrAfter)
  dayjs.extend(isSameOrBefore)
  dayjs.extend(timezone)
  dayjs.extend(utc)

  const { hubBus } = await import('./sync-bus')
  const { useUiStore } = await import('./store/ui')
  hubBus.onConnect(() => useUiStore.getState().setHubOnline(true))
  hubBus.onDisconnect(() => useUiStore.getState().setHubOnline(false))
  hubBus.connect()

  if (import.meta.env.DEV) {
    void import('./debug')
  }

  const { isNative } = await import('./platform')
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
  if (isNative() && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {})
  }

  const { wireGlassesStore } = await import('./glasses/store')
  const { wireG1Events } = await import('./glasses/events')
  wireGlassesStore()
  wireG1Events()

  const { wireGeocachingSubscription } = await import('./geocaching/subscribe')
  wireGeocachingSubscription()

  const { wireMeetupSubscription } = await import('./meetup/subscribe')
  wireMeetupSubscription()

  const { wireMapLayersSubscription } = await import('./map/layers-subscribe')
  wireMapLayersSubscription()

  const { App } = await import('./App')
  return { default: App }
})

type AuthState =
  | { kind: 'loading' }
  | { kind: 'unauth' }
  | { kind: 'auth'; email?: string }

interface SessionResponse {
  authenticated: boolean
  email?: string
}

export function GatedBoot() {
  const [state, setState] = useState<AuthState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function probe() {
      try {
        const res = await fetch(`${getHubUrl()}/auth/session`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        })
        if (!res.ok) {
          if (!cancelled) setState({ kind: 'unauth' })
          return
        }
        const body = (await res.json()) as SessionResponse
        if (cancelled) return
        setState(body.authenticated
          ? { kind: 'auth', email: body.email }
          : { kind: 'unauth' })
      } catch {
        if (!cancelled) setState({ kind: 'unauth' })
      }
    }
    void probe()
    return () => { cancelled = true }
  }, [])

  if (state.kind === 'loading') {
    // Render nothing while the session is being probed. No DOM scaffolding
    // is revealed during this window.
    return null
  }
  if (state.kind === 'unauth') {
    return <ForcedLoginScreen />
  }
  return (
    <Suspense fallback={null}>
      <LazyApp />
    </Suspense>
  )
}

/**
 * Variant of LoginScreen that doesn't depend on the global `authPending`
 * flag — we want it to render unconditionally for unauthenticated visitors.
 */
function ForcedLoginScreen() {
  // LoginScreen subscribes to a module-level pending flag; flip it on
  // mount so the component renders. We don't use the subscription here
  // because we control mount/unmount via the gate's state machine.
  return (
    <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center bg-bg-base text-text-primary">
      <div className="w-full max-w-sm flex flex-col items-center gap-6 p-8">
        <h1 className="text-lg font-medium">Console</h1>
        <p className="text-sm text-text-tertiary text-center">
          Sign in to continue.
        </p>
        <button
          onClick={() => {
            const ret = encodeURIComponent(window.location.href)
            // ?callback=app tells the hub to deep-link back via console://auth/done
            // with a one-time-token, so the WebView's cookie jar gets a fresh
            // session cookie (vs. the Custom Tab's jar which is unreachable).
            const cb = isNative() ? '&callback=app' : ''
            window.location.href = `${getHubUrl()}/auth/google/start?return=${ret}${cb}`
          }}
          className="px-4 py-2 bg-surface-2 hover:bg-surface-3 border border-border rounded text-sm transition-colors"
          autoFocus
        >
          Sign in with Google
        </button>
      </div>
    </div>
  )
}

// Re-export so existing imports (e.g. AccountModal) still resolve.
export { LoginScreen }
