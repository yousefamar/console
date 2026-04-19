import { useState } from 'react'
import { useUiStore } from '@/store/ui'
import { signOut } from '@/gmail/auth'
import { matrixLogout, isMatrixConnected } from '@/matrix/auth'
import { db } from '@/db'
import { X, Mail, MessageCircle, LogOut, BellOff, Bell } from 'lucide-react'
import { GlassesSettings } from './GlassesSettings'
import { glassesSupported } from '@/glasses/bridge'

export function AccountModal() {
  const setShowAccountModal = useUiStore((s) => s.setShowAccountModal)
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const userEmail = useUiStore((s) => s.userEmail)
  const matrixUserId = useUiStore((s) => s.matrixUserId)
  const doNotDisturb = useUiStore((s) => s.doNotDisturb)
  const setDoNotDisturb = useUiStore((s) => s.setDoNotDisturb)
  const matrixConnected = isMatrixConnected()

  const [signingOut, setSigningOut] = useState<'email' | 'matrix' | null>(null)

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

          {glassesSupported() && (
            <>
              <div className="border-t border-border" />
              <GlassesSettings />
            </>
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
