// Runtime platform detection.
//
// The Android APK (see `android/app/src/main/kotlin/io/amar/console/MainActivity.kt`)
// injects `window.__isConsoleAPK = true` on every page load. Any caller that needs
// different behavior in the native shell (e.g. OAuth callback scheme, persistent
// storage request, update banner) checks `isNative()`.

declare global {
  interface Window {
    __isConsoleAPK?: boolean
    __consoleAPK?: { version: string; code: number }
  }
}

export function isNative(): boolean {
  return typeof window !== 'undefined' && window.__isConsoleAPK === true
}

export function nativeVersion(): { version: string; code: number } | null {
  return (typeof window !== 'undefined' && window.__consoleAPK) || null
}

/**
 * Subscribe to OAuth return events dispatched by the native shell when the
 * `console://auth/done` deep link is invoked after Custom Tabs completes.
 */
export function onNativeAuthReturn(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = () => fn()
  window.addEventListener('console:auth-return', handler)
  return () => window.removeEventListener('console:auth-return', handler)
}
