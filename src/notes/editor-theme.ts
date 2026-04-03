// CodeMirror 6 theme matching Console's design system
import { EditorView } from '@codemirror/view'

export const consoleEditorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    height: '100%',
    color: 'var(--color-text-primary, #e4e4e7)',
    backgroundColor: 'var(--color-surface-0, #09090b)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.6',
    padding: '8px 0',
  },
  '.cm-content': {
    padding: '0 16px',
    color: 'var(--color-text-primary, #e4e4e7)',
    caretColor: 'var(--color-text-primary, #e4e4e7)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-text-primary, #e4e4e7)',
    borderLeftWidth: '2px',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--color-surface-1, rgba(255,255,255,0.03))',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--color-accent, #71717a) !important',
    opacity: '0.3',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-accent, #71717a) !important',
    opacity: '0.3',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: 'none',
    color: 'var(--color-text-tertiary, #52525b)',
    minWidth: '32px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    fontSize: '10px',
    padding: '0 4px 0 8px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 2px',
  },

  // Vim mode cursor
  '.cm-fat-cursor': {
    background: 'var(--color-text-primary, #e4e4e7) !important',
    color: 'var(--color-surface-0, #09090b) !important',
  },
  '&:not(.cm-focused) .cm-fat-cursor': {
    background: 'none !important',
    outline: '1px solid var(--color-text-tertiary, #52525b)',
    color: 'inherit !important',
  },

  // Panels (search etc)
  '.cm-panels': {
    backgroundColor: 'var(--color-surface-1, #18181b)',
    borderBottom: '1px solid var(--color-border, #27272a)',
    color: 'var(--color-text-primary, #e4e4e7)',
  },
  '.cm-panel input': {
    backgroundColor: 'var(--color-surface-2, #27272a)',
    color: 'var(--color-text-primary, #e4e4e7)',
    border: '1px solid var(--color-border, #27272a)',
    borderRadius: '2px',
    padding: '2px 6px',
    fontSize: '12px',
  },
  '.cm-panel button': {
    backgroundColor: 'var(--color-surface-2, #27272a)',
    color: 'var(--color-text-secondary, #a1a1aa)',
    border: '1px solid var(--color-border, #27272a)',
    borderRadius: '2px',
    padding: '2px 8px',
    fontSize: '11px',
  },

  // Tooltip
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface-1, #18181b)',
    border: '1px solid var(--color-border, #27272a)',
    color: 'var(--color-text-primary, #e4e4e7)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '2px 8px',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--color-surface-2, #27272a)',
    },
  },
})

// Light mode variant (when dark mode is off)
export const consoleEditorThemeLight = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    height: '100%',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.6',
    padding: '8px 0',
  },
  '.cm-content': {
    padding: '0 16px',
    caretColor: 'var(--color-text-primary, #18181b)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-text-primary, #18181b)',
    borderLeftWidth: '2px',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--color-surface-1, rgba(0,0,0,0.03))',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: 'none',
    color: 'var(--color-text-tertiary, #a1a1aa)',
    minWidth: '32px',
  },
  '.cm-fat-cursor': {
    background: 'var(--color-text-primary, #18181b) !important',
    color: 'var(--color-surface-0, #ffffff) !important',
  },
})
