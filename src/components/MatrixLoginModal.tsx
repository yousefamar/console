import { useState } from 'react'
import { matrixLogin } from '@/matrix/auth'
import { useUiStore } from '@/store/ui'
import { X, Eye, EyeOff } from 'lucide-react'

export function MatrixLoginModal() {
  const setShowMatrixLogin = useUiStore((s) => s.setShowMatrixLogin)
  const setMatrixUserId = useUiStore((s) => s.setMatrixUserId)

  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!server || !username || !password) return

    setLoading(true)
    setError('')

    try {
      await matrixLogin(server, username, password)
      setMatrixUserId(localStorage.getItem('matrix_user_id') ?? '')
      setShowMatrixLogin(false)
      // Reload to start Matrix sync
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => setShowMatrixLogin(false)} />
      <div className="relative z-10 w-full max-w-sm rounded-sm border border-border bg-surface-1 shadow-lg animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-medium text-text-primary">Connect Matrix</h3>
          <button
            onClick={() => setShowMatrixLogin(false)}
            className="text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
          >
            <X size={14} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3 p-4">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Homeserver</label>
            <input
              type="text"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="matrix.org"
              className="w-full rounded-sm border border-border bg-surface-0 px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary transition-colors"
              autoFocus
            />
            <p className="mt-0.5 text-[10px] text-text-tertiary">
              Domain name or full URL. Supports .well-known discovery.
            </p>
          </div>

          <div>
            <label className="block text-xs text-text-secondary mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@user:matrix.org"
              className="w-full rounded-sm border border-border bg-surface-0 px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs text-text-secondary mb-1">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-sm border border-border bg-surface-0 px-2.5 py-1.5 pr-8 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !server || !username || !password}
            className="w-full rounded-sm bg-text-primary px-3 py-1.5 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  )
}
