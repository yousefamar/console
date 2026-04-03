import { useEffect, useRef, memo } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, foldGutter, bracketMatching } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { vim, Vim } from '@replit/codemirror-vim'
import { consoleEditorTheme } from '@/notes/editor-theme'
import { livePreview } from '@/notes/live-preview'
import { useNotesStore } from '@/store/notes'

/** Toggle markdown formatting around selection. If already wrapped, unwrap. */
function wrapSelection(view: EditorView | null, marker: string) {
  if (!view) return
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const len = marker.length

  // Check if already wrapped — unwrap
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= len * 2) {
    const unwrapped = selected.slice(len, -len)
    view.dispatch({
      changes: { from, to, insert: unwrapped },
      selection: { anchor: from, head: from + unwrapped.length },
    })
    return
  }

  // Also check if markers are just outside the selection
  const before = view.state.sliceDoc(Math.max(0, from - len), from)
  const after = view.state.sliceDoc(to, to + len)
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - len, to: from, insert: '' },
        { from: to, to: to + len, insert: '' },
      ],
      selection: { anchor: from - len, head: to - len },
    })
    return
  }

  // Wrap selection (or insert empty markers at cursor)
  if (from === to) {
    // No selection — insert markers and place cursor between
    view.dispatch({
      changes: { from, insert: marker + marker },
      selection: { anchor: from + len },
    })
  } else {
    view.dispatch({
      changes: { from, to, insert: marker + selected + marker },
      selection: { anchor: from, head: from + len + selected.length + len },
    })
  }
}

interface Props {
  filePath: string
  content: string
}

export const NotesEditorCore = memo(function NotesEditorCore({ filePath, content }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const filePathRef = useRef(filePath)

  useEffect(() => {
    if (!containerRef.current) return

    // Register vim ex commands (idempotent — Vim.defineEx overwrites)
    Vim.defineEx('w', 'w', () => {
      useNotesStore.getState().saveFile()
    })
    Vim.defineEx('q', 'q', () => {
      const state = useNotesStore.getState()
      if (state.activeFilePath) {
        const closed = state.closeFile(state.activeFilePath, false)
        if (!closed) {
          console.warn('File has unsaved changes. Use :q! to force close.')
        }
      }
    })
    Vim.defineEx('q!', 'q!', () => {
      const state = useNotesStore.getState()
      if (state.activeFilePath) state.closeFile(state.activeFilePath, true)
    })
    Vim.defineEx('wq', 'wq', async () => {
      const state = useNotesStore.getState()
      await state.saveFile()
      if (state.activeFilePath) state.closeFile(state.activeFilePath, true)
    })

    const extensions = [
      // Intercept app-level shortcuts BEFORE vim consumes them
      Prec.highest(EditorView.domEventHandlers({
        keydown(event) {
          if ((event.ctrlKey || event.metaKey) && event.key === 'p') {
            event.preventDefault()
            useNotesStore.getState().openQuickSwitcher('filename')
            return true
          }
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault()
            useNotesStore.getState().openQuickSwitcher('content')
            return true
          }
          // Ctrl+Shift+T → reopen closed tab
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 't' || event.key === 'T')) {
            event.preventDefault()
            useNotesStore.getState().reopenLastClosedTab()
            return true
          }
          // Ctrl+Shift+P → command palette
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'p' || event.key === 'P')) {
            event.preventDefault()
            useNotesStore.getState().openCommandPalette()
            return true
          }
          // Ctrl+B → bold
          if ((event.ctrlKey || event.metaKey) && event.key === 'b') {
            event.preventDefault()
            wrapSelection(useNotesStore.getState().editorView, '**')
            return true
          }
          // Ctrl+I → italic
          if ((event.ctrlKey || event.metaKey) && event.key === 'i') {
            event.preventDefault()
            wrapSelection(useNotesStore.getState().editorView, '*')
            return true
          }
          // Ctrl+Shift+X → strikethrough
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'x' || event.key === 'X')) {
            event.preventDefault()
            wrapSelection(useNotesStore.getState().editorView, '~~')
            return true
          }
          // Ctrl+` → inline code
          if ((event.ctrlKey || event.metaKey) && event.key === '`') {
            event.preventDefault()
            wrapSelection(useNotesStore.getState().editorView, '`')
            return true
          }
          // Ctrl+K → link picker
          if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
            event.preventDefault()
            const view = useNotesStore.getState().editorView
            if (view) {
              const sel = view.state.selection.main
              const selectedText = view.state.sliceDoc(sel.from, sel.to)
              useNotesStore.getState().openLinkPicker({
                from: sel.from, to: sel.to, selectedText, mode: 'both',
              })
            }
            return true
          }
          return false
        },
      })),
      vim(),
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      foldGutter(),
      bracketMatching(),
      history(),
      syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
      highlightSelectionMatches(),
      yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }),
      livePreview(filePath),
      // Detect [[ typed in insert mode → open wiki link picker
      EditorView.inputHandler.of((view, from, to, text) => {
        if (text === '[' && from > 0 && view.state.sliceDoc(from - 1, from) === '[') {
          // [[ was just typed — open link picker at the [[ position
          setTimeout(() => {
            useNotesStore.getState().openLinkPicker({
              from: from - 1, to: to + 1, selectedText: '', mode: 'wiki',
            })
          }, 0)
        }
        return false // let the input happen normally
      }),
      EditorView.lineWrapping,
      consoleEditorTheme,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        {
          key: 'Mod-s',
          run: () => {
            useNotesStore.getState().saveFile()
            return true
          },
        },
      ]),
      EditorView.updateListener.of((() => {
        let pendingContent: string | null = null
        let rafId = 0
        return (update: any) => {
          if (update.docChanged) {
            pendingContent = update.state.doc.toString()
            if (!rafId) {
              rafId = requestAnimationFrame(() => {
                rafId = 0
                if (pendingContent !== null) {
                  useNotesStore.getState().updateFileContent(filePathRef.current, pendingContent)
                  pendingContent = null
                }
              })
            }
          }
        }
      })()),
      // Paste handler for images
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const items = event.clipboardData?.items
          if (!items) return false

          for (const item of items) {
            if (item.type.startsWith('image/')) {
              event.preventDefault()
              const blob = item.getAsFile()
              if (!blob) return true

              // Generate filename from timestamp
              const ext = item.type.split('/')[1] || 'png'
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
              const filename = `pasted-${timestamp}.${ext}`

              // Save image and insert markdown
              useNotesStore.getState().pasteImage(blob, filename).then((savedPath) => {
                if (savedPath) {
                  const cursor = view.state.selection.main.head
                  const insert = `![](${savedPath})\n`
                  view.dispatch({
                    changes: { from: cursor, insert },
                    selection: { anchor: cursor + insert.length },
                  })
                }
              })
              return true
            }
          }
          return false
        },
      }),
    ]

    // Register :link vim ex command
    Vim.defineEx('link', 'link', () => {
      const view = useNotesStore.getState().editorView
      if (!view) return
      const sel = view.state.selection.main
      useNotesStore.getState().openLinkPicker({
        from: sel.from, to: sel.to,
        selectedText: view.state.sliceDoc(sel.from, sel.to),
        mode: 'both',
      })
    })

    // Defer view creation to next frame to ensure DOM is laid out
    // (prevents coordsAt errors from vim's BlockCursorPlugin measuring before render)
    const frame = requestAnimationFrame(() => {
      if (!containerRef.current) return
      const view = new EditorView({
        state: EditorState.create({ doc: content, extensions }),
        parent: containerRef.current,
      })
      viewRef.current = view
      useNotesStore.getState().setEditorView(view)
    })

    return () => {
      cancelAnimationFrame(frame)
      useNotesStore.getState().setEditorView(null)
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [filePath]) // Re-create editor when file changes

  // Keep filePathRef in sync
  useEffect(() => {
    filePathRef.current = filePath
  }, [filePath])

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-hidden"
      data-notes-editor
    />
  )
})
