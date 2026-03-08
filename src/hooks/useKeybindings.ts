import { useEffect } from 'react'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'

export function useKeybindings() {
  const inbox = useInboxStore
  const ui = useUiStore

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const tag = target.tagName.toLowerCase()
      const isEditing = tag === 'input' || tag === 'textarea' || target.isContentEditable

      // Always active
      if (e.key === 'Escape') {
        e.preventDefault()
        if (ui.getState().showSearch) {
          ui.getState().setShowSearch(false)
        } else if (ui.getState().showKeybindingHelp) {
          ui.getState().setShowKeybindingHelp(false)
        } else if (ui.getState().showSnoozePicker) {
          ui.getState().setShowSnoozePicker(false)
        } else if (ui.getState().showCompose) {
          ui.getState().setShowCompose(false)
        } else if (inbox.getState().replyMode) {
          inbox.getState().setReplyMode(null)
        }
        return
      }

      // Cmd/Ctrl+Enter to send (works in editor)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        // Handled by compose editor
        return
      }

      // Don't intercept when editing text
      if (isEditing) return

      // Don't intercept Ctrl/Cmd/Alt combos (Ctrl+C, Cmd+A, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Navigation
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        inbox.getState().selectNextThread()
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        inbox.getState().selectPrevThread()
        return
      }

      // Triage
      if (e.key === 'e') {
        e.preventDefault()
        inbox.getState().archiveThread()
        return
      }
      if (e.key === 'b') {
        e.preventDefault()
        ui.getState().setShowSnoozePicker(true)
        return
      }

      // Reply
      if (e.key === 'r' && !e.shiftKey) {
        e.preventDefault()
        inbox.getState().setReplyMode('reply')
        return
      }
      if (e.key === 'R' || (e.key === 'r' && e.shiftKey)) {
        e.preventDefault()
        inbox.getState().setReplyMode('replyAll')
        return
      }
      if (e.key === 'f') {
        e.preventDefault()
        inbox.getState().setReplyMode('forward')
        return
      }

      // Compose
      if (e.key === 'c') {
        e.preventDefault()
        ui.getState().setShowCompose(true)
        return
      }

      // Search
      if (e.key === '/') {
        e.preventDefault()
        ui.getState().setShowSearch(true)
        return
      }

      // Help
      if (e.key === '?') {
        e.preventDefault()
        ui.getState().setShowKeybindingHelp(!ui.getState().showKeybindingHelp)
        return
      }

      // Undo
      if (e.key === 'u') {
        e.preventDefault()
        const undo = ui.getState().undoAction
        if (undo && Date.now() < undo.expiresAt) {
          undo.undo()
        }
        return
      }

      // Toggle dark mode
      if (e.key === 't' && e.shiftKey) {
        e.preventDefault()
        ui.getState().toggleDarkMode()
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
