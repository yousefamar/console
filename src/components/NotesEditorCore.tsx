import { useEffect, useRef, memo } from 'react'
import { EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, foldGutter, bracketMatching } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { vim, Vim } from '@replit/codemirror-vim'
import { consoleEditorTheme } from '@/notes/editor-theme'
import { livePreview } from '@/notes/live-preview'
import { useNotesStore } from '@/store/notes'
import { useBlogStore } from '@/store/blog'
import { useUiStore } from '@/store/ui'
import { showConfirm } from '@/dialog'
import { pushFromEditor, pushNow as pushMirrorNow, isEnabled as isMirrorEnabled } from '@/glasses/mirror'

/**
 * Active-line highlight that skips itself whenever the main selection has
 * extent (visual mode, mouse selection, etc.). CM6's built-in
 * `highlightActiveLine` always paints the line background, which sits above
 * the selection layer and washes the selection out. Suppressing the
 * decoration during a selection lets the selection background show clearly.
 */
const activeLineWhenCollapsed = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = this.compute(view) }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.compute(update.view)
      }
    }
    compute(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      const sel = view.state.selection.main
      if (sel.empty) {
        const line = view.state.doc.lineAt(sel.head)
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-activeLine' }))
      }
      return builder.finish()
    }
  },
  { decorations: (v) => v.decorations },
)

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

/**
 * Tag autocompletion for the YAML frontmatter `tags:` block list. Triggers when
 * the cursor is on a line that looks like `  - <prefix>` AND the line is inside
 * an open frontmatter block (between two `---` delimiters at the top of the
 * file) AND the nearest preceding key line is `tags:`.
 *
 * Tags come from `useBlogStore.tags`, which is populated from the hub's scan
 * of `log/*.md`. Most-used first.
 */
function tagCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  const beforeCursor = line.text.slice(0, context.pos - line.from)
  // Must be a list item line `  - <prefix>` inside frontmatter
  const m = beforeCursor.match(/^(\s*-\s)([^,\s]*)$/)
  if (!m) return null

  // Check we're inside frontmatter and that the closest preceding key is `tags:`
  const docText = context.state.doc.toString()
  if (!docText.startsWith('---\n')) return null
  const fmEnd = docText.indexOf('\n---', 4)
  if (fmEnd === -1 || context.pos > fmEnd) return null

  // Walk back from the current line to find the most recent `key:` line
  let foundTags = false
  for (let n = line.number - 1; n >= 1; n--) {
    const t = context.state.doc.line(n).text
    if (t === '---') break
    const kv = t.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/)
    if (kv) {
      foundTags = kv[1] === 'tags'
      break
    }
  }
  if (!foundTags) return null

  const prefix = m[2] ?? ''
  const tags = useBlogStore.getState().tags
  const filtered = prefix
    ? tags.filter((t) => t.toLowerCase().includes(prefix.toLowerCase()))
    : tags
  if (filtered.length === 0) return null

  return {
    from: context.pos - prefix.length,
    options: filtered.slice(0, 30).map((t) => ({ label: t, type: 'keyword' })),
    validFor: /^[\w-]*$/,
  }
}

export interface EditorOptions {
  /** Vim keybindings. Default true (current behaviour). */
  vim?: boolean
  /** Line numbers + fold gutter. Default true. */
  gutters?: boolean
}

interface Props {
  filePath: string
  content: string
  options?: EditorOptions
}

export const NotesEditorCore = memo(function NotesEditorCore({ filePath, content, options }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const filePathRef = useRef(filePath)
  const vimEnabled = options?.vim ?? true
  const guttersEnabled = options?.gutters ?? true

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
          // Ctrl+J / Ctrl+K → half-page scroll (clamped, no wrap)
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'j' || event.key === 'k')) {
            event.preventDefault()
            const view = useNotesStore.getState().editorView
            if (view) {
              const dir = event.key === 'j' ? 1 : -1
              const halfPage = Math.max(1, Math.floor(view.dom.clientHeight / view.defaultLineHeight / 2))
              const cur = view.state.doc.lineAt(view.state.selection.main.head)
              const targetLine = Math.max(1, Math.min(view.state.doc.lines, cur.number + dir * halfPage))
              const pos = view.state.doc.line(targetLine).from
              view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
            }
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
          // Ctrl+W → close current tab (matching nvim config)
          if ((event.ctrlKey || event.metaKey) && event.key === 'w') {
            event.preventDefault()
            const state = useNotesStore.getState()
            if (state.activeFilePath) {
              const closed = state.closeFile(state.activeFilePath, false)
              if (!closed) {
                // File is dirty — ask to save first
                void showConfirm('Save changes before closing?', { title: 'Unsaved changes', confirmLabel: 'Save & close', cancelLabel: 'Discard' }).then((save) => {
                  if (save) {
                    state.saveFile().then(() => state.closeFile(state.activeFilePath!, true))
                  } else {
                    state.closeFile(state.activeFilePath!, true)
                  }
                })
              }
            }
            return true
          }
          // Ctrl+N → new note
          if ((event.ctrlKey || event.metaKey) && event.key === 'n' && !event.shiftKey) {
            event.preventDefault()
            useNotesStore.getState().openNewFileForm()
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
          // Ctrl+Shift+K → link picker
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'k' || event.key === 'K')) {
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
      ...(vimEnabled ? [vim()] : []),
      ...(guttersEnabled ? [lineNumbers()] : []),
      activeLineWhenCollapsed,
      drawSelection(),
      // Browser-native spellcheck (red squiggles + right-click suggestions).
      // CM6 disables it by default — turning it on here. In vim mode,
      // autocorrect/autocapitalize stay off so the editor doesn't munge
      // code-y prose; in plain mode (mobile writing) they're on for prose.
      EditorView.contentAttributes.of(
        vimEnabled
          ? { spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }
          : { spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' },
      ),
      ...(guttersEnabled ? [foldGutter()] : []),
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
      autocompletion({ override: [tagCompletion] }),
      consoleEditorTheme,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Tab', run: indentMore },
        { key: 'Shift-Tab', run: indentLess },
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
          // Notes → glasses mirror — push on doc or selection change.
          // `pushFromEditor` short-circuits when the toggle is off.
          if (update.docChanged || update.selectionSet) {
            pushFromEditor(update.state)
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

              // Save image and insert an embed. pasteImage returns a bare
              // filename when the image landed in the sibling assets dir
              // (wiki-embed form — what Obsidian + Eleventy expect) or a
              // vault path from the offline fallback (markdown form).
              useNotesStore.getState().pasteImage(blob, filename).then((savedPath) => {
                if (savedPath) {
                  const cursor = view.state.selection.main.head
                  const insert = savedPath.includes('/') ? `![](${savedPath})\n` : `![[${savedPath}]]\n`
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

    // Vim options (equivalent to nvim's `set clipboard=unnamedplus`)
    // Map y/d/p to use system clipboard register (+) by default
    Vim.noremap('y', '"+y', 'normal')
    Vim.noremap('Y', '"+Y', 'normal')
    Vim.noremap('y', '"+y', 'visual')
    Vim.noremap('d', '"+d', 'normal')
    Vim.noremap('D', '"+D', 'normal')
    Vim.noremap('d', '"+d', 'visual')
    Vim.noremap('p', '"+p', 'normal')
    Vim.noremap('P', '"+P', 'normal')
    Vim.noremap('p', '"+p', 'visual')
    // j/k navigate wrapped lines (gj/gk)
    Vim.noremap('j', 'gj', 'normal')
    Vim.noremap('k', 'gk', 'normal')

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

    Vim.defineEx('publish', 'publish', async () => {
      const notes = useNotesStore.getState()
      const ui = useUiStore.getState()
      const blog = useBlogStore.getState()
      const path = notes.activeFilePath
      if (!path) {
        ui.pushToast({ kind: 'error', message: 'No file open to publish' })
        return
      }
      // Save first so unsaved changes are included
      try { await notes.saveFile() } catch {}
      ui.pushToast({ kind: 'info', message: 'Publishing…', detail: path })
      const result = await blog.publish(path)
      if (!result.ok) {
        ui.pushToast({ kind: 'error', message: 'Publish failed', detail: result.error })
        return
      }
      // Close the (now-deleted) draft tab and refresh tree + drafts list
      try { notes.closeFile(path, true) } catch {}
      void notes.loadVaultFiles()
      void blog.refreshDrafts()
      void blog.refreshProjects()
      if (result.rebuildOk) {
        const { permalinkForLogPath } = await import('@/utils/frontmatter')
        ui.pushToast({
          kind: 'success',
          message: 'Published',
          detail: result.newPath,
          href: (result.newPath && permalinkForLogPath(result.newPath)) || 'https://yousefamar.com/memo/log/',
        })
      } else {
        ui.pushToast({
          kind: 'error',
          message: 'Moved, but rebuild failed',
          detail: result.rebuildBody?.slice(0, 200) ?? 'no response',
        })
      }
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
      // If the glasses mirror is already on, push the initial window so the
      // user sees the opening context without waiting for a keystroke.
      if (isMirrorEnabled()) pushMirrorNow()
    })

    return () => {
      cancelAnimationFrame(frame)
      useNotesStore.getState().setEditorView(null)
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [filePath, vimEnabled, guttersEnabled]) // Re-create editor when file or editor options change

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
