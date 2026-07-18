// "Pair this APK" — mints a hub bearer token via the authenticated SPA.
//
// Two delivery modes:
//  • Inside the legacy Android WebView (isNative()): hand the plaintext to
//    the native shell via window.ConsoleNative.setHubToken (v38 and earlier).
//  • In a desktop/mobile browser: render a QR of
//    `console://pair?hub=<url>&token=<plaintext>` — scanning it with the
//    phone camera deep-links into the NATIVE Console app (v39+), which
//    stores the token and reconnects. The plaintext is also shown once for
//    manual paste into the app's Settings screen.
//
// The token is shown ONCE at the moment of minting — it goes into the APK's
// EncryptedSharedPreferences and the SPA never sees it again.

import { useEffect, useState } from 'react'
import { Smartphone, Check, AlertCircle, X } from 'lucide-react'
import QRCode from 'qrcode'
import { hubFetch, getHubUrl } from '@/hub'
import { isNative } from '@/platform'

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
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [paired, setPaired] = useState<boolean>(() => {
    try { return window.ConsoleNative?.hasHubToken?.() ?? false } catch { return false }
  })
  // Probe `hasHubToken` periodically — the bridge may not exist on first
  // render (WebView injects after page load). Browser: stays false, harmless.
  useEffect(() => {
    if (!isNative()) return
    const t = setInterval(() => {
      try { setPaired(window.ConsoleNative?.hasHubToken?.() ?? false) } catch { /* ignore */ }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  async function mint(): Promise<MintResponse> {
    const name = `APK ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    return hubFetch<MintResponse>('/auth/hub/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, scope: 'apk' }),
    })
  }

  async function pair() {
    setBusy(true)
    setError(null)
    try {
      const res = await mint()

      if (isNative()) {
        // Legacy WebView path (v38-): hand over via the JS bridge.
        //
        // CRITICAL: Android's addJavascriptInterface methods must be invoked AS A
        // MEMBER of the injected object (`native.setHubToken(x)`). Extracting the
        // method into a local detaches it from the injected object and throws
        // "Java bridge method can't be invoked on a non-injected object".
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
        return
      }

      // Browser path: QR for the native app. The phone camera scanning this
      // opens console://pair?... which the app's intent filter claims.
      const pairUri = `console://pair?hub=${encodeURIComponent(getHubUrl())}&token=${encodeURIComponent(res.plaintext)}`
      const dataUrl = await QRCode.toDataURL(pairUri, {
        margin: 1,
        width: 220,
        color: { dark: '#e5e5e5', light: '#0a0a0a' },
      })
      setQrDataUrl(dataUrl)
      setPlaintext(res.plaintext)
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

  function dismissQr() {
    setQrDataUrl(null)
    setPlaintext(null)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Smartphone size={13} className="text-text-tertiary flex-shrink-0" />
          <span className="text-sm text-text-secondary truncate">
            {isNative()
              ? (paired ? 'This APK is paired' : 'Pair this APK with the hub')
              : 'Pair the Console app'}
          </span>
        </div>
        {isNative() && paired ? (
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
            {busy ? 'Pairing…' : isNative() ? 'Pair' : 'Show pairing QR'}
          </button>
        )}
        {error && (
          <span className="flex items-center gap-1 text-[10px] text-destructive">
            <AlertCircle size={10} /> {error}
          </span>
        )}
      </div>
      {qrDataUrl && (
        <div className="flex flex-col items-center gap-2 p-3 bg-bg-secondary rounded border border-border">
          <div className="flex items-center justify-between w-full">
            <span className="text-xs text-text-tertiary">Scan with the phone camera</span>
            <button onClick={dismissQr} className="text-text-tertiary hover:text-text-primary">
              <X size={12} />
            </button>
          </div>
          <img src={qrDataUrl} alt="Pairing QR" width={220} height={220} className="rounded" />
          {plaintext && (
            <code className="text-[10px] text-text-tertiary break-all select-all">
              {plaintext}
            </code>
          )}
          <span className="text-[10px] text-text-tertiary">
            Shown once — or paste the token into the app&apos;s Settings.
          </span>
        </div>
      )}
    </div>
  )
}
