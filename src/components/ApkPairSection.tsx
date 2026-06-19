// "Pair this APK" — mints a hub bearer token via the authenticated SPA and
// hands it to the native shell via window.ConsoleNative.setHubToken.
//
// Only renders inside the Android WebView (isNative() === true). The token
// is shown ONCE at the moment of minting — it goes straight into the APK's
// EncryptedSharedPreferences and the SPA never sees it again.

import { useEffect, useState } from 'react'
import { Smartphone, Check, AlertCircle } from 'lucide-react'
import { hubFetch } from '@/hub'

interface MintResponse {
  id: string
  name: string
  scope: string
  createdAt: number
  plaintext: string
}

export function ApkPairSection() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paired, setPaired] = useState<boolean>(() => {
    try { return window.ConsoleNative?.hasHubToken?.() ?? false } catch { return false }
  })
  // Probe `hasHubToken` periodically — the bridge may not exist on first
  // render (WebView injects after page load).
  useEffect(() => {
    const t = setInterval(() => {
      try { setPaired(window.ConsoleNative?.hasHubToken?.() ?? false) } catch { /* ignore */ }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  async function pair() {
    setBusy(true)
    setError(null)
    try {
      const name = `APK ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
      const res = await hubFetch<MintResponse>('/auth/hub/tokens', {
        method: 'POST',
        body: JSON.stringify({ name, scope: 'apk' }),
      })
      // Retry the bridge call a few times — WebView occasionally injects
      // the interface slightly after first paint.
      //
      // CRITICAL: Android's addJavascriptInterface methods must be invoked AS A
      // MEMBER of the injected object (`native.setHubToken(x)`). Extracting the
      // method into a local (`const fn = native.setHubToken; fn(x)`) detaches it
      // from the injected object and throws "Java bridge method can't be invoked
      // on a non-injected object". So keep `native` and call through it.
      const tryBridge = (attempt: number) => {
        const native = window.ConsoleNative
        if (native && typeof native.setHubToken === 'function') {
          try {
            native.setHubToken(res.plaintext)
            setPaired(true)
          } catch (e) {
            setError(`setHubToken failed: ${(e as Error)?.message || String(e)}`)
          }
          return
        }
        if (attempt >= 5) {
          setError('ConsoleNative.setHubToken not available — is this an APK build?')
          return
        }
        setTimeout(() => tryBridge(attempt + 1), 200)
      }
      tryBridge(0)
    } catch (err) {
      setError((err as Error)?.message || 'mint failed')
    } finally {
      setBusy(false)
    }
  }

  function unpair() {
    try {
      window.ConsoleNative?.clearHubToken?.()
      setPaired(false)
    } catch (err) {
      setError((err as Error)?.message || 'unpair failed')
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <Smartphone size={13} className="text-text-tertiary flex-shrink-0" />
        <span className="text-sm text-text-secondary truncate">
          {paired ? 'This APK is paired' : 'Pair this APK with the hub'}
        </span>
      </div>
      {paired ? (
        <button
          onClick={unpair}
          className="flex items-center gap-1 text-xs text-text-tertiary hover:text-destructive transition-colors duration-fast flex-shrink-0"
        >
          <Check size={11} /> Unpair
        </button>
      ) : (
        <button
          onClick={pair}
          disabled={busy}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast disabled:opacity-50"
        >
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      )}
      {error && (
        <span className="flex items-center gap-1 text-[10px] text-destructive">
          <AlertCircle size={10} /> {error}
        </span>
      )}
    </div>
  )
}
