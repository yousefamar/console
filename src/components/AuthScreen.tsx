import { useState } from 'react'
import { signIn } from '@/gmail/auth'
import { useUiStore } from '@/store/ui'
import { getMeta } from '@/db'

interface AuthScreenProps {
  onAuth: () => void
}

export function AuthScreen({ onAuth }: AuthScreenProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn() {
    setLoading(true)
    setError(null)
    try {
      await signIn()
      const email = await getMeta('email')
      if (email) {
        useUiStore.getState().setUserEmail(email)
      }
      onAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface-0">
      <div className="w-80 space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-text-primary tracking-tight">Console</h1>
          <p className="text-sm text-text-secondary">
            Sign in with Google to sync your inbox.
          </p>
        </div>

        <button
          onClick={handleSignIn}
          disabled={loading}
          className="w-full rounded-sm bg-accent px-4 py-2 text-sm font-medium text-white transition-colors duration-fast hover:bg-accent-hover disabled:opacity-50"
        >
          {loading ? 'Connecting...' : 'Sign in with Google'}
        </button>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <p className="text-xs text-text-tertiary">
          Your data stays in your browser. We never see your emails.
        </p>
      </div>
    </div>
  )
}
