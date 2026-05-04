// Replacement for window.alert / window.confirm / window.prompt.
//
// Imperative API that returns a Promise. The actual UI is rendered by
// `<Dialog/>` in App.tsx, which reads `useUiStore.dialog`.
//
// Why imperative rather than declarative React state in each call site:
// most call sites are deep inside event handlers that don't want the
// ceremony of holding modal open/close state. `await showConfirm(...)` reads
// like `confirm(...)` which is what every existing call already did.

import { useUiStore } from '@/store/ui'

let nextId = 1

interface AlertOpts { title?: string; confirmLabel?: string }
interface ConfirmOpts { title?: string; danger?: boolean; confirmLabel?: string; cancelLabel?: string }
interface PromptOpts { title?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; cancelLabel?: string }

export function showAlert(message: string, opts: AlertOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    useUiStore.getState().setDialog({
      id: nextId++,
      kind: 'alert',
      message,
      title: opts.title,
      confirmLabel: opts.confirmLabel ?? 'OK',
      resolve: () => resolve(),
    })
  })
}

export function showConfirm(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    useUiStore.getState().setDialog({
      id: nextId++,
      kind: 'confirm',
      message,
      title: opts.title,
      danger: opts.danger ?? false,
      confirmLabel: opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      resolve: (v) => resolve(v as boolean),
    })
  })
}

export function showPrompt(message: string, opts: PromptOpts = {}): Promise<string | null> {
  return new Promise((resolve) => {
    useUiStore.getState().setDialog({
      id: nextId++,
      kind: 'prompt',
      message,
      title: opts.title,
      defaultValue: opts.defaultValue ?? '',
      placeholder: opts.placeholder,
      confirmLabel: opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      resolve: (v) => resolve(v as string | null),
    })
  })
}
