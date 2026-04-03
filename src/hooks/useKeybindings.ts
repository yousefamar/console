import { useEffect } from 'react'
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useAgentStore } from '@/store/agent'
import { useBookmarkStore } from '@/store/bookmarks'
import { useNotesStore } from '@/store/notes'
import { useFeedStore } from '@/store/feeds'
import { useCalendarStore } from '@/store/calendar'
import { useUiStore } from '@/store/ui'

export function useKeybindings() {
  const inbox = useInboxStore
  const chat = useChatStore
  const agent = useAgentStore
  const bm = useBookmarkStore
  const notes = useNotesStore
  const feeds = useFeedStore
  const cal = useCalendarStore
  const ui = useUiStore

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const tag = target.tagName.toLowerCase()
      const isEditing = tag === 'input' || tag === 'textarea' || target.isContentEditable
      const activePane = ui.getState().activePane
      const isEmail = activePane === 'email'
      const isBookmarks = activePane === 'bookmarks'
      const isNotes = activePane === 'notes'
      const isAgents = activePane === 'agents'
      const isFeeds = activePane === 'feeds'
      const isCalendar = activePane === 'calendar'

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
        } else if (isBookmarks && isEditing) {
          ;(target as HTMLElement).blur()
        } else if (isBookmarks && bm.getState().triageMode) {
          bm.getState().exitTriageMode()
        } else if (isBookmarks && bm.getState().searchQuery) {
          bm.getState().setSearchQuery('')
          bm.getState().selectTag(null)
        } else if (isBookmarks && bm.getState().selectedBookmarkId) {
          bm.getState().selectBookmark(null)
        } else if (isCalendar && cal.getState().showEventForm) {
          cal.getState().closeEventForm()
        } else if (isCalendar && cal.getState().selectedEventId) {
          cal.getState().selectEvent(null)
        } else if (isFeeds && feeds.getState().showAddModal) {
          feeds.getState().setShowAddModal(false)
        } else if (isFeeds && isEditing) {
          ;(target as HTMLElement).blur()
        } else if (isFeeds && feeds.getState().searchQuery) {
          feeds.getState().setSearchQuery('')
        } else if (isFeeds && feeds.getState().selectedItemId) {
          feeds.getState().selectItem(null)
        } else if (isNotes && notes.getState().commandPaletteOpen) {
          notes.getState().closeCommandPalette()
        } else if (isNotes && notes.getState().linkPickerOpen) {
          notes.getState().closeLinkPicker()
        } else if (isNotes && notes.getState().quickSwitcherOpen) {
          notes.getState().closeQuickSwitcher()
        } else if (isNotes && isEditing) {
          // Let CodeMirror/vim handle Escape in editor
          return
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

      // Notes: Ctrl+Shift+T for reopen closed tab
      if (isNotes && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        notes.getState().reopenLastClosedTab()
        return
      }

      // Notes: Ctrl+Shift+P for command palette, Ctrl+P for Quick Switcher, Ctrl+Shift+F for content search
      if (isNotes && (e.ctrlKey || e.metaKey)) {
        if (e.shiftKey && (e.key === 'p' || e.key === 'P')) {
          e.preventDefault()
          notes.getState().openCommandPalette()
          return
        }
        if (e.key === 'p') {
          e.preventDefault()
          notes.getState().openQuickSwitcher('filename')
          return
        }
        if (e.key === 'F' || (e.key === 'f' && e.shiftKey)) {
          e.preventDefault()
          notes.getState().openQuickSwitcher('content')
          return
        }
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

      // Calendar-specific keybindings
      if (isCalendar) {
        if (e.key === 't') {
          e.preventDefault()
          cal.getState().navigateToday()
          return
        }
        if (e.key === 'h' || e.key === 'ArrowLeft') {
          e.preventDefault()
          cal.getState().navigateWeek(-1)
          return
        }
        if (e.key === 'l' || e.key === 'ArrowRight') {
          e.preventDefault()
          cal.getState().navigateWeek(1)
          return
        }
        if (e.key === 'w') {
          e.preventDefault()
          cal.getState().setView('week')
          return
        }
        if (e.key === 'd') {
          e.preventDefault()
          cal.getState().setView('day')
          return
        }
        if (e.key === 'c') {
          e.preventDefault()
          cal.getState().openCreateForm()
          return
        }
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
        return // Don't fall through
      }

      // Feed-specific keybindings
      if (isFeeds) {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault()
          feeds.getState().selectNextItem()
          return
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault()
          feeds.getState().selectPrevItem()
          return
        }
        if (e.key === 'e') {
          e.preventDefault()
          feeds.getState().markRead()
          return
        }
        if (e.key === 'E') {
          e.preventDefault()
          const { selectedFeedId, selectedFolderId } = feeds.getState()
          if (selectedFeedId) feeds.getState().markFeedRead(selectedFeedId)
          else if (selectedFolderId) feeds.getState().markFolderRead(selectedFolderId)
          return
        }
        if (e.key === 'u') {
          e.preventDefault()
          const itemId = feeds.getState().selectedItemId
          if (itemId) feeds.getState().markUnread(itemId)
          return
        }
        if (e.key === 'o') {
          e.preventDefault()
          feeds.getState().openItemInBrowser()
          return
        }
        if (e.key === 'a') {
          e.preventDefault()
          feeds.getState().setShowAddModal(true)
          return
        }
        if (e.key === 'd') {
          e.preventDefault()
          const fid = feeds.getState().selectedFeedId
          if (fid) feeds.getState().deleteFeed(fid)
          return
        }
        if (e.key === '/') {
          e.preventDefault()
          const input = document.querySelector<HTMLInputElement>('[data-feed-search]')
          input?.focus()
          return
        }
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
        return // Don't fall through
      }

      // Bookmark-specific keybindings
      if (isBookmarks) {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault()
          bm.getState().selectNextBookmark()
          return
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault()
          bm.getState().selectPrevBookmark()
          return
        }
        if (e.key === 'e') {
          e.preventDefault()
          if (bm.getState().triageMode) bm.getState().triageKeep()
          return
        }
        if (e.key === 'd') {
          e.preventDefault()
          if (bm.getState().triageMode) bm.getState().triageDelete()
          else bm.getState().deleteBookmark()
          return
        }
        if (e.key === 's') {
          e.preventDefault()
          if (bm.getState().triageMode) bm.getState().triageSkip()
          return
        }
        if (e.key === 'o') {
          e.preventDefault()
          bm.getState().openBookmarkUrl()
          return
        }
        if (e.key === 'm') {
          e.preventDefault()
          if (bm.getState().triageMode) bm.getState().exitTriageMode()
          else bm.getState().enterTriageMode()
          return
        }
        if (e.key === 't' && !e.shiftKey) {
          e.preventDefault()
          const input = document.querySelector<HTMLInputElement>('[data-bookmark-tag-input]')
          input?.focus()
          return
        }
        if (e.key === '/') {
          e.preventDefault()
          const input = document.querySelector<HTMLInputElement>('[data-bookmark-search]')
          input?.focus()
          return
        }
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

      // Notes-specific keybindings
      // When editor (CodeMirror) is focused, it handles its own keys via vim mode.
      // These only apply when the tree sidebar or other non-editor elements are focused.
      if (isNotes) {
        // Ctrl+P / Ctrl+Shift+F — always intercept for quick switcher / search
        // (handled before the isEditing check below)

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
        if (e.key === '/') {
          e.preventDefault()
          notes.getState().openQuickSwitcher()
          return
        }
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault()
          notes.getState().nextTab()
          return
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault()
          notes.getState().prevTab()
          return
        }
        if (e.key === 'e') {
          e.preventDefault()
          const path = notes.getState().activeFilePath
          if (path) notes.getState().closeFile(path, false)
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
      if (e.key === 'E' || (e.key === 'e' && e.shiftKey)) {
        e.preventDefault()
        if (!isEmail) chat.getState().markRoomUnread()
        return
      }
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
