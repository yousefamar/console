import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUiStore } from '@/store/ui'

// Mock document.documentElement for toggleDarkMode
vi.stubGlobal('document', {
  documentElement: {
    classList: {
      toggle: vi.fn(),
    },
  },
})

beforeEach(() => {
  useUiStore.setState({
    darkMode: true,
    emailDarkMode: true,
    showSearch: false,
    showKeybindingHelp: false,
    showSnoozePicker: false,
    showSchedulePicker: false,
    showCompose: false,
    syncStatus: 'idle',
    syncDetail: '',
    queueCount: 0,
    undoAction: null,
    userEmail: '',
    needsReAuth: false,
  })
})

describe('dark mode toggles', () => {
  it('toggleDarkMode flips darkMode', () => {
    expect(useUiStore.getState().darkMode).toBe(true)
    useUiStore.getState().toggleDarkMode()
    expect(useUiStore.getState().darkMode).toBe(false)
    useUiStore.getState().toggleDarkMode()
    expect(useUiStore.getState().darkMode).toBe(true)
  })

  it('toggleDarkMode calls document.documentElement.classList.toggle', () => {
    useUiStore.getState().toggleDarkMode()
    expect(document.documentElement.classList.toggle).toHaveBeenCalledWith('dark', false)
  })

  it('toggleEmailDarkMode flips emailDarkMode', () => {
    expect(useUiStore.getState().emailDarkMode).toBe(true)
    useUiStore.getState().toggleEmailDarkMode()
    expect(useUiStore.getState().emailDarkMode).toBe(false)
  })
})

describe('panel toggles', () => {
  it('setShowSearch', () => {
    useUiStore.getState().setShowSearch(true)
    expect(useUiStore.getState().showSearch).toBe(true)
    useUiStore.getState().setShowSearch(false)
    expect(useUiStore.getState().showSearch).toBe(false)
  })

  it('setShowKeybindingHelp', () => {
    useUiStore.getState().setShowKeybindingHelp(true)
    expect(useUiStore.getState().showKeybindingHelp).toBe(true)
  })

  it('setShowSnoozePicker', () => {
    useUiStore.getState().setShowSnoozePicker(true)
    expect(useUiStore.getState().showSnoozePicker).toBe(true)
  })

  it('setShowSchedulePicker', () => {
    useUiStore.getState().setShowSchedulePicker(true)
    expect(useUiStore.getState().showSchedulePicker).toBe(true)
  })

  it('setShowCompose', () => {
    useUiStore.getState().setShowCompose(true)
    expect(useUiStore.getState().showCompose).toBe(true)
  })
})

describe('sync state', () => {
  it('setSyncStatus sets status and detail', () => {
    useUiStore.getState().setSyncStatus('syncing', 'Fetching threads...')
    expect(useUiStore.getState().syncStatus).toBe('syncing')
    expect(useUiStore.getState().syncDetail).toBe('Fetching threads...')
  })

  it('setSyncStatus defaults detail to empty string', () => {
    useUiStore.getState().setSyncStatus('error')
    expect(useUiStore.getState().syncStatus).toBe('error')
    expect(useUiStore.getState().syncDetail).toBe('')
  })

  it('setQueueCount', () => {
    useUiStore.getState().setQueueCount(5)
    expect(useUiStore.getState().queueCount).toBe(5)
  })
})

describe('undo action', () => {
  it('setUndoAction sets and clears', () => {
    const action = {
      label: 'Archived',
      undo: async () => {},
      expiresAt: Date.now() + 5000,
    }
    useUiStore.getState().setUndoAction(action)
    expect(useUiStore.getState().undoAction).toBe(action)

    useUiStore.getState().setUndoAction(null)
    expect(useUiStore.getState().undoAction).toBeNull()
  })
})

describe('auth state', () => {
  it('setUserEmail', () => {
    useUiStore.getState().setUserEmail('user@gmail.com')
    expect(useUiStore.getState().userEmail).toBe('user@gmail.com')
  })

  it('setNeedsReAuth', () => {
    useUiStore.getState().setNeedsReAuth(true)
    expect(useUiStore.getState().needsReAuth).toBe(true)
    useUiStore.getState().setNeedsReAuth(false)
    expect(useUiStore.getState().needsReAuth).toBe(false)
  })
})
