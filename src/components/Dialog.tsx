import { useEffect, useRef, useState } from 'react'
import { useUiStore } from '@/store/ui'

export function Dialog() {
  const dialog = useUiStore((s) => s.dialog)
  const setDialog = useUiStore((s) => s.setDialog)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  // Reset value when a new prompt opens (keyed on dialog.id)
  useEffect(() => {
    if (!dialog) return
    if (dialog.kind === 'prompt') {
      setValue(dialog.defaultValue ?? '')
      // Focus + select after mount
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    } else {
      setTimeout(() => okRef.current?.focus(), 0)
    }
  }, [dialog?.id])

  if (!dialog) return null

  const close = (resolved: unknown) => {
    dialog.resolve(resolved)
    setDialog(null)
  }

  const onOk = () => {
    if (dialog.kind === 'alert') close(undefined)
    else if (dialog.kind === 'confirm') close(true)
    else close(value)  // prompt — pass current value (caller may want empty string)
  }

  const onCancel = () => {
    if (dialog.kind === 'alert') close(undefined)
    else if (dialog.kind === 'confirm') close(false)
    else close(null)  // prompt cancel — null distinguishes from empty string
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && dialog.kind !== 'alert') {
      e.preventDefault()
      onOk()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
      onKeyDown={handleKey}
    >
      <div className="w-full max-w-md mx-4 bg-surface-1 border border-border rounded-sm shadow-2xl overflow-hidden">
        {dialog.title && (
          <div className="px-4 pt-3 pb-1 text-xs font-medium text-text-secondary uppercase tracking-wide">
            {dialog.title}
          </div>
        )}
        <div className="px-4 py-3 text-sm text-text-primary whitespace-pre-line">
          {dialog.message}
        </div>
        {dialog.kind === 'prompt' && (
          <div className="px-4 pb-3">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={dialog.placeholder}
              className="w-full px-2 py-1.5 text-sm bg-surface-0 border border-border rounded-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent"
            />
          </div>
        )}
        <div className="flex justify-end gap-2 px-4 py-2 border-t border-border bg-surface-0">
          {dialog.kind !== 'alert' && (
            <button
              onClick={onCancel}
              className="px-3 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors duration-fast"
            >
              {dialog.cancelLabel}
            </button>
          )}
          <button
            ref={okRef}
            onClick={onOk}
            className={`px-3 py-1 text-xs rounded-sm transition-colors duration-fast ${
              dialog.danger
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-accent text-white hover:bg-accent-hover'
            }`}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
