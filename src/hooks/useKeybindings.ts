import { useEffect } from 'react'
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useAgentStore } from '@/store/agent'
import { useUiStore } from '@/store/ui'

export function useKeybindings() {
  const inbox = useInboxStore
  const chat = useChatStore
  const agent = useAgentStore
  const ui = useUiStore

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const tag = target.tagName.toLowerCase()
      const isEditing = tag === 'input' || tag === 'textarea' || target.isContentEditable
      const activePane = ui.getState().activePane
      const isEmail = activePane === 'email'
      const isAgents = activePane === 'agents'

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
        } else if (ui.getState().showMatrixLogin) {
          ui.getState().setShowMatrixLogin(false)
        } else if (ui.getState().showAccountModal) {
          ui.getState().setShowAccountModal(false)
        } else if (isAgents && isEditing) {
          // Agent pane: Esc from input blurs first (vim-like: insert → normal mode)
          ;(target as HTMLElement).blur()
        } else if (isAgents && agent.getState().sessions.find((s) => s.id === agent.getState().activeSessionId)?.status === 'running') {
          agent.getState().interrupt()
        } else if (isAgents && agent.getState().activeSessionId) {
          agent.getState().selectSession(null)
        } else if (inbox.getState().replyMode) {
          inbox.getState().setReplyMode(null)
        } else if (isEditing) {
          // First Esc blurs the input (vim-like: insert → normal mode)
          ;(target as HTMLElement).blur()
        } else if (activePane === 'chat' && chat.getState().selectedRoomId) {
          // In chat: Esc deselects room (drops read rooms from list)
          chat.getState().selectRoom(null)
        }
        return
      }

      // Cmd/Ctrl+Enter to send (works in editor)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        // Handled by compose editor / agent prompt input
        return
      }

      // Don't intercept when editing text
      if (isEditing) return

      // Don't intercept Ctrl/Cmd/Alt combos (Ctrl+C, Cmd+A, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Tab to switch between panes
      if (e.key === 'Tab') {
        e.preventDefault()
        ui.getState().toggleActivePane()
        return
      }

      // Agent-specific keybindings
      if (isAgents) {
        const approval = agent.getState().pendingApproval
        // y/n/a shortcuts only for standard tool approval, not AskUserQuestion
        if (approval && approval.toolName !== 'AskUserQuestion') {
          if (e.key === 'y') {
            e.preventDefault()
            agent.getState().approveTool(approval.requestId)
            return
          }
          if (e.key === 'n') {
            e.preventDefault()
            agent.getState().denyTool(approval.requestId, 'Denied by user')
            return
          }
          if (e.key === 'a') {
            e.preventDefault()
            agent.getState().autoApproveTool(approval.toolName)
            return
          }
        }
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault()
          agent.getState().selectNextSession()
          return
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault()
          agent.getState().selectPrevSession()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          // Focus the prompt input
          const input = document.querySelector<HTMLTextAreaElement>('[data-agent-input]')
          input?.focus()
          return
        }
        // Help and dark mode still work
        if (e.key === '?') {
          e.preventDefault()
          ui.getState().setShowKeybindingHelp(!ui.getState().showKeybindingHelp)
          return
        }
        if (e.key === 't' && e.shiftKey) {
          e.preventDefault()
          ui.getState().toggleDarkMode()
          return
        }
        return // Don't fall through to email/chat bindings
      }

      // Navigation — dispatches to email or chat store based on active pane
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (isEmail) inbox.getState().selectNextThread()
        else chat.getState().selectNextRoom()
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (isEmail) inbox.getState().selectPrevThread()
        else chat.getState().selectPrevRoom()
        return
      }

      // Triage — context-dependent
      if (e.key === 'e') {
        e.preventDefault()
        if (isEmail) inbox.getState().archiveThread()
        else chat.getState().markRoomRead()
        return
      }
      if (e.key === 'b') {
        e.preventDefault()
        ui.getState().setShowSnoozePicker(true)
        return
      }

      // Reply (email only)
      if (isEmail) {
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
      }

      // Insert mode (chat): focus compose input
      if (e.key === 'i' && !isEmail) {
        e.preventDefault()
        const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
        input?.focus()
        return
      }

      // Compose (email only)
      if (e.key === 'c') {
        e.preventDefault()
        if (isEmail) ui.getState().setShowCompose(true)
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
