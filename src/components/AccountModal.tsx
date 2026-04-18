import { useState, useEffect } from 'react'
import { useUiStore } from '@/store/ui'
import { signOut } from '@/gmail/auth'
import { matrixLogout, isMatrixConnected, getMatrixHomeserver } from '@/matrix/auth'
import { db } from '@/db'
import { X, Mail, MessageCircle, LogOut, Eye, EyeOff, BellOff, Bell, Server } from 'lucide-react'
import { getHubUrl } from '@/hub'

export function AccountModal() {
  const setShowAccountModal = useUiStore((s) => s.setShowAccountModal)
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const userEmail = useUiStore((s) => s.userEmail)
  const matrixUserId = useUiStore((s) => s.matrixUserId)
  const doNotDisturb = useUiStore((s) => s.doNotDisturb)
  const setDoNotDisturb = useUiStore((s) => s.setDoNotDisturb)
  const matrixConnected = isMatrixConnected()

  const [signingOut, setSigningOut] = useState<'email' | 'matrix' | null>(null)

  // Hub Matrix client state (hub owns OlmMachine now)
  const [hubStatus, setHubStatus] = useState<{ cryptoReady: boolean; deviceId?: string } | null>(null)
  const [showHubLogin, setShowHubLogin] = useState(false)
  const [hubPassword, setHubPassword] = useState('')
  const [showHubPassword, setShowHubPassword] = useState(false)
  const [hubLoginStatus, setHubLoginStatus] = useState<'idle' | 'logging-in' | 'done' | 'error'>('idle')
  const [hubLoginDetail, setHubLoginDetail] = useState('')

  useEffect(() => {
    if (!matrixConnected) return
    fetch(`${getHubUrl()}/matrix/hub/status`)
      .then((r) => r.json())
      .then((s) => setHubStatus(s))
      .catch(() => {})
  }, [matrixConnected, hubLoginStatus])

  async function handleEmailSignOut() {
    setSigningOut('email')
    await signOut()
    window.location.reload()
  }

  async function handleMatrixDisconnect() {
    setSigningOut('matrix')
    await matrixLogout()
    // Clear chat data
    await db.chatRooms.clear()
    await db.chatMessages.clear()
    // Legacy browser crypto store cleanup (no-op if absent)
    try {
      indexedDB.deleteDatabase('console-crypto-store')
    } catch {
      // Best effort
    }
    window.location.reload()
  }

  function handleConnectMatrix() {
    setShowAccountModal(false)
    setShowMatrixLogin(true)
  }

  async function handleHubLogin() {
    if (!hubPassword.trim()) return
    const hs = getMatrixHomeserver()
    const mxid = matrixUserId
    if (!hs || !mxid) {
      setHubLoginStatus('error')
      setHubLoginDetail('No Matrix session — connect first')
      return
    }
    setHubLoginStatus('logging-in')
    setHubLoginDetail('Logging hub into homeserver...')
    try {
      const res = await fetch(`${getHubUrl()}/matrix/hub/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeserver: hs, userId: mxid, password: hubPassword }),
      })
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
      const data = await res.json() as { deviceId: string; importedRoomKeys: number; totalRoomKeysInBackup: number }
      setHubLoginStatus('done')
      setHubLoginDetail(`Hub device ${data.deviceId} — imported ${data.importedRoomKeys}/${data.totalRoomKeysInBackup} keys`)
      setHubPassword('')
    } catch (err) {
      setHubLoginStatus('error')
      setHubLoginDetail(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => setShowAccountModal(false)} />

      <div className="relative z-10 w-full max-w-xs rounded-sm border border-border bg-surface-1 shadow-lg animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h3 className="text-sm font-medium text-text-primary">Settings</h3>
          <button
            onClick={() => setShowAccountModal(false)}
            className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
          >
            <X size={14} />
          </button>
        </div>

        {/* Settings */}
        <div className="p-3 space-y-3">
          {/* Do Not Disturb */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {doNotDisturb ? <BellOff size={13} className="text-text-tertiary" /> : <Bell size={13} className="text-text-tertiary" />}
              <span className="text-sm text-text-secondary">Do Not Disturb</span>
            </div>
            <button
              onClick={() => setDoNotDisturb(!doNotDisturb)}
              className={`relative w-7 h-4 rounded-full transition-colors duration-fast ${doNotDisturb ? 'bg-text-secondary' : 'bg-surface-2'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-surface-0 transition-transform duration-fast ${doNotDisturb ? 'translate-x-3' : ''}`} />
            </button>
          </div>

          <div className="border-t border-border" />

          {/* Email account */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Mail size={13} className="text-text-tertiary flex-shrink-0" />
              <span className="text-sm text-text-secondary truncate">
                {userEmail || 'Gmail'}
              </span>
            </div>
            <button
              onClick={handleEmailSignOut}
              disabled={signingOut !== null}
              className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast flex-shrink-0 disabled:opacity-50"
            >
              <LogOut size={11} />
              <span>{signingOut === 'email' ? 'Signing out...' : 'Sign out'}</span>
            </button>
          </div>

          {/* Matrix account */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <MessageCircle size={13} className="text-text-tertiary flex-shrink-0" />
              {matrixConnected ? (
                <span className="text-sm text-text-secondary truncate">
                  {matrixUserId || 'Matrix'}
                </span>
              ) : (
                <span className="text-sm text-text-tertiary italic">Not connected</span>
              )}
            </div>
            {matrixConnected ? (
              <button
                onClick={handleMatrixDisconnect}
                disabled={signingOut !== null}
                className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast flex-shrink-0 disabled:opacity-50"
              >
                <LogOut size={11} />
                <span>{signingOut === 'matrix' ? 'Disconnecting...' : 'Disconnect'}</span>
              </button>
            ) : (
              <button
                onClick={handleConnectMatrix}
                className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast flex-shrink-0"
              >
                Connect
              </button>
            )}
          </div>

        </div>

        {/* Hub Matrix client */}
        {matrixConnected && (
          <div className="px-3 pb-3">
            <div className="border-t border-border pt-3">
              {hubStatus?.cryptoReady ? (
                <div className="flex items-center gap-2 text-xs text-green-400">
                  <Server size={11} />
                  <span>Hub Matrix client active ({hubStatus.deviceId})</span>
                </div>
              ) : !showHubLogin ? (
                <button
                  onClick={() => setShowHubLogin(true)}
                  className="flex items-center gap-2 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                >
                  <Server size={11} />
                  <span>Migrate Matrix to hub (M1)</span>
                </button>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs text-text-tertiary">Matrix password (for hub login)</label>
                  <div className="relative">
                    <input
                      type={showHubPassword ? 'text' : 'password'}
                      value={hubPassword}
                      onChange={(e) => setHubPassword(e.target.value)}
                      placeholder="Password"
                      disabled={hubLoginStatus === 'logging-in'}
                      className="w-full rounded-sm border border-border bg-surface-0 px-2 py-1.5 pr-7 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-text-tertiary disabled:opacity-50"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleHubLogin()
                        if (e.key === 'Escape') setShowHubLogin(false)
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowHubPassword(!showHubPassword)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                      tabIndex={-1}
                    >
                      {showHubPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-xs ${hubLoginStatus === 'error' ? 'text-red-400' : hubLoginStatus === 'done' ? 'text-green-400' : 'text-text-tertiary'}`}>
                      {hubLoginDetail}
                    </span>
                    <button
                      onClick={handleHubLogin}
                      disabled={hubLoginStatus === 'logging-in' || !hubPassword.trim()}
                      className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast disabled:opacity-50"
                    >
                      {hubLoginStatus === 'logging-in' ? 'Logging in...' : 'Log in hub'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Build info */}
        <div className="px-4 py-2 border-t border-border">
          <span className="text-[10px] text-text-tertiary">
            Built {formatBuildAge(__BUILD_TIME__)}
          </span>
        </div>
      </div>
    </div>
  )
}

function formatBuildAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
