import { useEffect } from 'react'
import { useUiStore } from '@/store/ui'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)

  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.map((t) => {
      const remaining = t.expiresAt - Date.now()
      return setTimeout(() => dismiss(t.id), Math.max(0, remaining))
    })
    return () => { for (const t of timers) clearTimeout(t) }
  }, [toasts, dismiss])

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertCircle : Info
        const accent = t.kind === 'success' ? 'text-green-400' : t.kind === 'error' ? 'text-red-400' : 'text-blue-400'
        return (
          <div
            key={t.id}
            onClick={() => { if (t.href) window.open(t.href, '_blank', 'noopener,noreferrer') }}
            className={`pointer-events-auto flex items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2 shadow-lg max-w-sm transition-all ${
              t.href ? 'cursor-pointer hover:bg-surface-1' : ''
            }`}
          >
            <Icon size={14} className={`${accent} mt-0.5 shrink-0`} />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-text-primary">{t.message}</div>
              {t.detail && <div className="text-[10px] text-text-tertiary mt-0.5 break-all">{t.detail}</div>}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); dismiss(t.id) }}
              className="text-text-tertiary hover:text-text-secondary shrink-0"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
