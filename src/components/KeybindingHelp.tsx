import { useUiStore } from '@/store/ui'

const BINDINGS = [
  { section: 'Navigation', items: [
    { key: 'j / ↓', action: 'Next item' },
    { key: 'k / ↑', action: 'Previous item' },
    { key: 'Tab', action: 'Switch pane' },
    { key: '/', action: 'Search' },
  ]},
  { section: 'Triage', items: [
    { key: 'e', action: 'Done (mail) / Read (chat)' },
    { key: 'b', action: 'Snooze' },
    { key: 'u', action: 'Undo' },
  ]},
  { section: 'Compose', items: [
    { key: 'i', action: 'Focus chat input' },
    { key: 'r', action: 'Reply' },
    { key: 'R', action: 'Reply all' },
    { key: 'f', action: 'Forward' },
    { key: 'c', action: 'New message' },
    { key: '⌘/Ctrl + ↵', action: 'Send' },
  ]},
  { section: 'Bookmarks', items: [
    { key: 'e', action: 'Keep (triage)' },
    { key: 'd', action: 'Delete bookmark' },
    { key: 's', action: 'Skip (triage)' },
    { key: 'o', action: 'Open URL' },
    { key: 'm', action: 'Toggle triage mode' },
    { key: 't', action: 'Focus tag input' },
  ]},
  { section: 'Notes', items: [
    { key: 'Ctrl + Shift + P', action: 'Command palette' },
    { key: 'Ctrl + P', action: 'Find file (Quick Switcher)' },
    { key: 'Ctrl + K', action: 'Insert link' },
    { key: '[[', action: 'Insert wiki link (insert mode)' },
    { key: 'Ctrl + S', action: 'Save file' },
    { key: ':w', action: 'Save (vim)' },
    { key: ':q', action: 'Close tab' },
    { key: ':wq', action: 'Save and close' },
    { key: 'gt / gT', action: 'Next / prev tab' },
  ]},
  { section: 'Feeds', items: [
    { key: 'e', action: 'Mark read + next' },
    { key: 'E', action: 'Mark feed read' },
    { key: 'u', action: 'Mark unread' },
    { key: 'o', action: 'Open in browser' },
    { key: 'a', action: 'Add feed' },
    { key: 'd', action: 'Delete feed' },
  ]},
  { section: 'Calendar', items: [
    { key: 'h / l', action: 'Prev / next week' },
    { key: 't', action: 'Go to today' },
    { key: 'w / d', action: 'Week / day view' },
    { key: 'c', action: 'Create event' },
  ]},
  { section: 'Money', items: [
    { key: 'j / k', action: 'Navigate transactions' },
    { key: '/', action: 'Search transactions' },
    { key: 'n', action: 'Add note' },
    { key: 'c', action: 'Cycle category filter' },
  ]},
  { section: 'Agents', items: [
    { key: 'y', action: 'Allow tool' },
    { key: 'n', action: 'Deny tool' },
    { key: 'a', action: 'Allow all (tool type)' },
    { key: 'Enter', action: 'Focus prompt input' },
    { key: 'Esc', action: 'Interrupt agent' },
  ]},
  { section: 'App', items: [
    { key: 'Esc', action: 'Close / cancel' },
    { key: 'Shift + T', action: 'Toggle dark mode' },
    { key: '?', action: 'Toggle this help' },
  ]},
]

export function KeybindingHelp() {
  const setShowKeybindingHelp = useUiStore((s) => s.setShowKeybindingHelp)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => setShowKeybindingHelp(false)} />

      <div className="relative z-10 w-96 rounded-sm border border-border bg-surface-1 shadow-lg animate-slide-up">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h3 className="text-sm font-medium text-text-primary">Keyboard shortcuts</h3>
          <button
            onClick={() => setShowKeybindingHelp(false)}
            className="text-xs text-text-tertiary hover:text-text-secondary"
          >
            Esc
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
          {BINDINGS.map((section) => (
            <div key={section.section}>
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-text-tertiary">
                {section.section}
              </h4>
              <div className="space-y-1">
                {section.items.map((item) => (
                  <div key={item.key} className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">{item.action}</span>
                    <kbd className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-xs font-mono text-text-tertiary">
                      {item.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
