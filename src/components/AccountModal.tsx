import { useState, useEffect } from 'react'
import { useUiStore } from '@/store/ui'
import { signOut } from '@/gmail/auth'
import { matrixLogout, isMatrixConnected } from '@/matrix/auth'
import { isCryptoReady, initCrypto, getCrossSigningStatus, bootstrapAndVerifyDevice } from '@/matrix/crypto'
import { getMatrixUserId, getMatrixDeviceId } from '@/matrix/auth'
import { db } from '@/db'
import { X, Mail, MessageCircle, LogOut, KeyRound, ShieldCheck, Eye, EyeOff, BellOff, Bell } from 'lucide-react'

export function AccountModal() {
  const setShowAccountModal = useUiStore((s) => s.setShowAccountModal)
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const userEmail = useUiStore((s) => s.userEmail)
  const matrixUserId = useUiStore((s) => s.matrixUserId)
  const doNotDisturb = useUiStore((s) => s.doNotDisturb)
  const setDoNotDisturb = useUiStore((s) => s.setDoNotDisturb)
  const matrixConnected = isMatrixConnected()

  const [signingOut, setSigningOut] = useState<'email' | 'matrix' | null>(null)
  const [showKeyRestore, setShowKeyRestore] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restoring' | 'done' | 'error'>('idle')
  const [restoreDetail, setRestoreDetail] = useState('')
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null)

  // Device verification state
  const [showVerify, setShowVerify] = useState(false)
  const [verifyPassword, setVerifyPassword] = useState('')
  const [showVerifyPassword, setShowVerifyPassword] = useState(false)
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'done' | 'error'>('idle')
  const [verifyDetail, setVerifyDetail] = useState('')
  const [deviceVerified, setDeviceVerified] = useState<boolean | null>(null)

  // Check cross-signing status on mount
  useEffect(() => {
    if (matrixConnected && isCryptoReady()) {
      getCrossSigningStatus().then((status) => {
        setDeviceVerified(status.deviceVerified)
      })
    }
  }, [matrixConnected])

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
    // Clear crypto store
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

  async function handleVerifyDevice() {
    if (!verifyPassword.trim()) return
    setVerifyStatus('verifying')
    setVerifyDetail('Initializing...')

    try {
      if (!isCryptoReady()) {
        const userId = getMatrixUserId()
        const deviceId = getMatrixDeviceId()
        if (!userId || !deviceId) {
          setVerifyStatus('error')
          setVerifyDetail('Missing Matrix credentials')
          return
        }
        setVerifyDetail('Initializing crypto...')
        await initCrypto(userId, deviceId)
      }
      setVerifyDetail('Bootstrapping cross-signing...')
      const newKey = await bootstrapAndVerifyDevice(verifyPassword)
      setVerifyStatus('done')
      setVerifyDetail('All devices verified')
      setDeviceVerified(true)
      setVerifyPassword('')
      setNewRecoveryKey(newKey)
    } catch (err) {
      setVerifyStatus('error')
      setVerifyDetail(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  async function handleKeyRestore() {
    if (!recoveryKey.trim()) return
    setRestoreStatus('restoring')
    setRestoreDetail('Decrypting backup...')

    try {
      if (!isCryptoReady()) {
        setRestoreDetail('Initializing crypto...')
        const userId = getMatrixUserId()
        const deviceId = getMatrixDeviceId()
        if (!userId || !deviceId) {
          setRestoreStatus('error')
          setRestoreDetail('Missing Matrix credentials')
          return
        }
        await initCrypto(userId, deviceId)
      }
      const { restoreKeyBackup } = await import('@/matrix/key-backup')
      const count = await restoreKeyBackup(recoveryKey, (imported, total) => {
        setRestoreDetail(`${imported}/${total} keys`)
      })
      setRestoreStatus('done')
      setRestoreDetail(`${count} keys restored`)

      // Re-decrypt stored messages
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch (err) {
      setRestoreStatus('error')
      setRestoreDetail(err instanceof Error ? err.message : 'Unknown error')
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

          {/* Device verification (Matrix cross-signing) */}
          {matrixConnected && (
            <div className="border-t border-border pt-3">
              {deviceVerified === true ? (
                <div className="flex items-center gap-2 text-xs text-green-400">
                  <ShieldCheck size={11} />
                  <span>Device verified</span>
                </div>
              ) : !showVerify ? (
                <button
                  onClick={() => setShowVerify(true)}
                  className="flex items-center gap-2 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                >
                  <ShieldCheck size={11} />
                  <span>{deviceVerified === false ? 'Verify this device (required to send)' : 'Verify this device'}</span>
                </button>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs text-text-tertiary">Matrix password</label>
                  <div className="relative">
                    <input
                      type={showVerifyPassword ? 'text' : 'password'}
                      value={verifyPassword}
                      onChange={(e) => setVerifyPassword(e.target.value)}
                      placeholder="Password"
                      disabled={verifyStatus === 'verifying'}
                      className="w-full rounded-sm border border-border bg-surface-0 px-2 py-1.5 pr-7 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-text-tertiary disabled:opacity-50"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleVerifyDevice()
                        if (e.key === 'Escape') setShowVerify(false)
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowVerifyPassword(!showVerifyPassword)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                      tabIndex={-1}
                    >
                      {showVerifyPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-xs ${verifyStatus === 'error' ? 'text-red-400' : verifyStatus === 'done' ? 'text-green-400' : 'text-text-tertiary'}`}>
                      {verifyDetail}
                    </span>
                    <button
                      onClick={handleVerifyDevice}
                      disabled={verifyStatus === 'verifying' || !verifyPassword.trim()}
                      className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast disabled:opacity-50"
                    >
                      {verifyStatus === 'verifying' ? 'Verifying...' : 'Verify'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* New recovery key display */}
          {newRecoveryKey && (
            <div className="border-t border-border pt-3 space-y-2">
              <label className="block text-xs font-medium text-yellow-400">New recovery key — save this now!</label>
              <div className="bg-surface-0 border border-border rounded-sm p-2">
                <code className="text-xs text-text-primary font-mono break-all select-all">{newRecoveryKey}</code>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newRecoveryKey)
                  setNewRecoveryKey(null)
                }}
                className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              >
                Copy & dismiss
              </button>
            </div>
          )}

          {/* Key restore (Matrix E2EE) */}
          {matrixConnected && (
            <div className="border-t border-border pt-3">
              {!showKeyRestore ? (
                <button
                  onClick={() => setShowKeyRestore(true)}
                  className="flex items-center gap-2 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                >
                  <KeyRound size={11} />
                  <span>Restore encrypted message keys</span>
                </button>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs text-text-tertiary">Recovery key</label>
                  <input
                    type="text"
                    value={recoveryKey}
                    onChange={(e) => setRecoveryKey(e.target.value)}
                    placeholder="EsUB 6NJa ..."
                    disabled={restoreStatus === 'restoring'}
                    className="w-full rounded-sm border border-border bg-surface-0 px-2 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-text-tertiary disabled:opacity-50"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleKeyRestore()
                      if (e.key === 'Escape') setShowKeyRestore(false)
                    }}
                  />
                  <div className="flex items-center justify-between">
                    <span className={`text-xs ${restoreStatus === 'error' ? 'text-red-400' : restoreStatus === 'done' ? 'text-green-400' : 'text-text-tertiary'}`}>
                      {restoreDetail}
                    </span>
                    <button
                      onClick={handleKeyRestore}
                      disabled={restoreStatus === 'restoring' || !recoveryKey.trim()}
                      className="text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast disabled:opacity-50"
                    >
                      {restoreStatus === 'restoring' ? 'Restoring...' : 'Restore'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

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
