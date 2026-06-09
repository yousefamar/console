import { useEffect, useState } from 'react'
import { useUiStore } from '@/store/ui'

export function UndoToast() {
  const undoAction = useUiStore((s) => s.undoAction)
  const setUndoAction = useUiStore((s) => s.setUndoAction)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!undoAction) {
      setVisible(false)
      return
    }

    setVisible(true)
    const timeout = undoAction.expiresAt - Date.now()
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(() => setUndoAction(null), 200)
    }, timeout)

    return () => clearTimeout(timer)
  }, [undoAction, setUndoAction])

  if (!undoAction) return null

  return (
    <div
      className={`fixed bottom-20 md:bottom-4 left-1/2 z-50 -translate-x-1/2 transition-all duration-200 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      <div className="flex items-center gap-3 rounded-sm border border-border bg-surface-2 px-4 py-2 shadow-lg">
        <span className="text-sm text-text-primary">{undoAction.label}</span>
        <button
          onClick={() => {
            undoAction.undo()
          }}
          className="text-sm font-medium text-accent hover:text-accent-hover transition-colors duration-fast"
        >
          Undo
          <span className="ml-1 text-text-tertiary">u</span>
        </button>
      </div>
    </div>
  )
}
