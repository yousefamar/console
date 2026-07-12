// Obsidian-style live preview for CodeMirror 6
// Renders markdown inline while editing — cursor reveals raw syntax

import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { type Range, type Extension, RangeSetBuilder, Facet, StateField, type EditorState } from '@codemirror/state'

/** Facet to provide the current file path to the live preview plugin */
export const currentFileFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
})

// ---------------------------------------------------------------------------
// Widget classes
// ---------------------------------------------------------------------------

class HorizontalRuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr')
    hr.className = 'cm-hr-widget'
    return hr
  }
}

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean) { super() }
  toDOM() {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = this.checked
    cb.className = 'cm-checkbox-widget'
    cb.setAttribute('aria-label', this.checked ? 'Checked' : 'Unchecked')
    return cb
  }
}


class WikiLinkWidget extends WidgetType {
  constructor(private text: string) { super() }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-wikilink-widget'
    // Handle display text with alias: [[target|display]]
    const pipeIdx = this.text.indexOf('|')
    span.textContent = pipeIdx >= 0 ? this.text.slice(pipeIdx + 1) : this.text
    span.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const target = pipeIdx >= 0 ? this.text.slice(0, pipeIdx) : this.text
      // Resolve wiki-link to vault file path and open
      import('@/store/notes').then(({ useNotesStore }) => {
        const { files, openFile } = useNotesStore.getState()
        const match = files.find((f) =>
          f.name.replace(/\.md$/, '') === target || f.path === target || f.path === target + '.md'
        )
        if (match) openFile(match.path)
      })
    })
    return span
  }
}

class LinkWidget extends WidgetType {
  constructor(private text: string, private url: string) { super() }
  toDOM() {
    const a = document.createElement('a')
    a.className = 'cm-link-widget'
    a.textContent = this.text
    a.href = this.url
    a.title = this.url
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      window.open(this.url, '_blank', 'noopener')
    })
    return a
  }
}

// Image blob URL cache — resolves vault-relative paths to displayable blob URLs.
// Successful resolutions cache the blob URL forever; misses are cached only
// briefly (NEGATIVE_TTL) so a TRANSIENT failure — hub restarting, an asset
// route not yet deployed, a network blip — self-heals on the next render
// instead of poisoning the image until a full page reload.
const IMAGE_NOT_FOUND = '__not_found__'
const NEGATIVE_TTL = 20_000
const imageBlobCache = new Map<string, string>()
const imageNotFoundAt = new Map<string, number>()
const imagePendingLoads = new Set<string>()
let imageLoadCallback: (() => void) | null = null

/** Synchronous cache read for the widget: returns a blob URL, the not-found
 *  sentinel (only while the negative entry is still fresh), or undefined. */
function readImageCache(cacheKey: string): string | undefined {
  const url = imageBlobCache.get(cacheKey)
  if (url) return url
  const missedAt = imageNotFoundAt.get(cacheKey)
  if (missedAt !== undefined) {
    if (Date.now() - missedAt < NEGATIVE_TTL) return IMAGE_NOT_FOUND
    imageNotFoundAt.delete(cacheKey) // expired — allow a retry
  }
  return undefined
}

/** Clear all negative cache entries and re-render, so poisoned images retry
 *  immediately (e.g. after the hub reconnects). */
export function retryFailedImages(): void {
  if (imageNotFoundAt.size === 0) return
  imageNotFoundAt.clear()
  imageLoadCallback?.()
}

async function resolveVaultImage(src: string, fromFile: string): Promise<string | null> {
  const cacheKey = `${fromFile}::${src}`
  const cached = readImageCache(cacheKey)
  if (cached === IMAGE_NOT_FOUND) return null
  if (cached) return cached
  if (imagePendingLoads.has(cacheKey)) return null

  // External URLs — use directly
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    imageBlobCache.set(cacheKey, src)
    return src
  }

  // Vault-relative — async resolve
  imagePendingLoads.add(cacheKey)
  const { useNotesStore } = await import('@/store/notes')
  const url = await useNotesStore.getState().resolveImageUrl(src, fromFile)
  imagePendingLoads.delete(cacheKey)
  if (url) {
    imageBlobCache.set(cacheKey, url)
    imageNotFoundAt.delete(cacheKey)
  } else {
    imageNotFoundAt.set(cacheKey, Date.now())
  }
  // Trigger decoration rebuild either way (to show found image or "not found")
  imageLoadCallback?.()
  return url
}

class ImageWidget extends WidgetType {
  constructor(private src: string, private alt: string, private fromFile: string) { super() }
  toDOM() {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-image-widget'

    const cacheKey = `${this.fromFile}::${this.src}`
    const cached = readImageCache(cacheKey)

    if (cached && cached !== IMAGE_NOT_FOUND) {
      const img = document.createElement('img')
      img.src = cached
      img.alt = this.alt
      img.loading = 'lazy'
      img.style.maxWidth = '100%'
      img.style.maxHeight = '300px'
      img.style.borderRadius = '2px'
      wrapper.appendChild(img)
    } else if (cached === IMAGE_NOT_FOUND) {
      const placeholder = document.createElement('div')
      placeholder.className = 'cm-image-placeholder'
      placeholder.textContent = `Image not found: ${this.src}`
      wrapper.appendChild(placeholder)
    } else {
      const placeholder = document.createElement('div')
      placeholder.className = 'cm-image-placeholder'
      placeholder.textContent = `Loading: ${this.src}`
      wrapper.appendChild(placeholder)
      resolveVaultImage(this.src, this.fromFile)
    }

    return wrapper
  }
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

/** Build the complete decoration set for ALL lines (ignoring cursor position).
 *  This is the expensive operation — only called on docChanged/viewportChanged. */
function buildAllDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  // Get current file path for resolving relative image paths
  const currentFile = view.state.facet(currentFileFacet)

  const decorations: Range<Decoration>[] = []

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const type = node.type.name
        const text = doc.sliceString(node.from, node.to)

        // ATX Headings
        if (type.match(/^ATXHeading([1-6])$/)) {
          const level = parseInt(type.slice(-1))
          const hashEnd = text.indexOf(' ')
          if (hashEnd > 0) {
            // Hide the # markers
            decorations.push(
              Decoration.replace({}).range(node.from, node.from + hashEnd + 1)
            )
            // Style the heading text
            decorations.push(
              Decoration.mark({
                class: `cm-heading cm-heading-${level}`,
              }).range(node.from + hashEnd + 1, node.to)
            )
          }
          return false // don't recurse into heading content
        }

        // Bold (StrongEmphasis)
        if (type === 'StrongEmphasis') {
          // Hide the ** markers
          decorations.push(Decoration.replace({}).range(node.from, node.from + 2))
          decorations.push(Decoration.replace({}).range(node.to - 2, node.to))
          decorations.push(
            Decoration.mark({ class: 'cm-strong' }).range(node.from + 2, node.to - 2)
          )
          return false
        }

        // Italic (Emphasis)
        if (type === 'Emphasis') {
          decorations.push(Decoration.replace({}).range(node.from, node.from + 1))
          decorations.push(Decoration.replace({}).range(node.to - 1, node.to))
          decorations.push(
            Decoration.mark({ class: 'cm-em' }).range(node.from + 1, node.to - 1)
          )
          return false
        }

        // Strikethrough
        if (type === 'Strikethrough') {
          decorations.push(Decoration.replace({}).range(node.from, node.from + 2))
          decorations.push(Decoration.replace({}).range(node.to - 2, node.to))
          decorations.push(
            Decoration.mark({ class: 'cm-strikethrough' }).range(node.from + 2, node.to - 2)
          )
          return false
        }

        // Inline code
        if (type === 'InlineCode') {
          // Find backtick positions
          if (text.startsWith('`') && text.endsWith('`')) {
            decorations.push(Decoration.replace({}).range(node.from, node.from + 1))
            decorations.push(Decoration.replace({}).range(node.to - 1, node.to))
            decorations.push(
              Decoration.mark({ class: 'cm-inline-code' }).range(node.from + 1, node.to - 1)
            )
          }
          return false
        }

        // Links [text](url)
        if (type === 'Link') {
          const linkText = doc.sliceString(node.from, node.to)
          const match = linkText.match(/^\[(.+?)\]\((.+?)\)$/)
          if (match) {
            decorations.push(
              Decoration.replace({
                widget: new LinkWidget(match[1]!, match[2]!),
              }).range(node.from, node.to)
            )
          }
          return false
        }

        // Images ![alt](src)
        if (type === 'Image') {
          const imgText = doc.sliceString(node.from, node.to)
          const match = imgText.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
          if (match) {
            decorations.push(
              Decoration.replace({
                widget: new ImageWidget(match[2]!, match[1]!, currentFile),
              }).range(node.from, node.to)
            )
          }
          return false
        }

        // Horizontal Rule
        if (type === 'HorizontalRule') {
          decorations.push(
            Decoration.replace({
              widget: new HorizontalRuleWidget(),
            }).range(node.from, node.to)
          )
          return false
        }

        // Blockquote markers
        if (type === 'Blockquote') {
          decorations.push(
            Decoration.mark({ class: 'cm-blockquote' }).range(node.from, node.to)
          )
        }

        // Code blocks — just mark them, syntax highlighting handled by lang support
        if (type === 'FencedCode') {
          decorations.push(
            Decoration.mark({ class: 'cm-codeblock' }).range(node.from, node.to)
          )
          return false
        }

        // YAML Frontmatter — handled by separate StateField (block decorations
        // cannot be provided via ViewPlugin)
        if (type === 'Frontmatter') {
          return false
        }
      },
    })
  }

  // Handle wiki-links and checkboxes via regex (lezer may not parse these)
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to)

    // Wiki image embeds ![[image.png]]
    const wikiImgRe = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|webp|svg|bmp))\]\]/gi
    let match
    while ((match = wikiImgRe.exec(text)) !== null) {
      const start = from + match.index
      const end = start + match[0].length
      decorations.push(
        Decoration.replace({
          widget: new ImageWidget(match[1]!, match[1]!, currentFile),
        }).range(start, end)
      )
    }

    // Wiki-links [[page]]
    const wikiRe = /\[\[([^\]]+)\]\]/g
    while ((match = wikiRe.exec(text)) !== null) {
      const start = from + match.index
      const end = start + match[0].length
      decorations.push(
        Decoration.replace({
          widget: new WikiLinkWidget(match[1]!),
        }).range(start, end)
      )
    }

    // Checkboxes - [ ] and - [x]
    const cbRe = /^(\s*[-*+]\s+)\[([ xX])\]/gm
    while ((match = cbRe.exec(text)) !== null) {
      const start = from + match.index + match[1]!.length
      const end = start + 3
      const checked = match[2]!.toLowerCase() === 'x'
      decorations.push(
        Decoration.replace({
          widget: new CheckboxWidget(checked),
        }).range(start, end)
      )
    }
  }

  // Sort by position and add to builder
  decorations.sort((a, b) => a.from - b.from || a.to - b.to)

  // Filter overlapping decorations
  let lastEnd = 0
  for (const d of decorations) {
    if (d.from >= lastEnd) {
      builder.add(d.from, d.to, d.value)
      lastEnd = d.to
    }
  }

  return builder.finish()
}

/** Cheap filter: remove decorations overlapping the cursor line.
 *  Uses DecorationSet.update({ filter }) which is O(log n). */
function filterForCursorLine(allDecos: DecorationSet, state: EditorState): DecorationSet {
  const cursorLine = state.doc.lineAt(state.selection.main.head)
  return allDecos.update({
    filter: (from, to) => to < cursorLine.from || from > cursorLine.to,
  })
}

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Frontmatter StateField — block decorations must come from StateField,
// not ViewPlugin (CM6 restriction)
// ---------------------------------------------------------------------------

function buildFrontmatterDecorations(state: any): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = state.doc

  // Detect frontmatter via regex (reliable regardless of async tree parsing)
  const docStart = doc.sliceString(0, Math.min(doc.length, 5000))
  const fmMatch = docStart.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const fmEnd = fmMatch[0].length
    // Always style frontmatter — never collapse into widget
    // (collapsing causes layout shifts that break vim cursor tracking)
    builder.add(0, fmEnd, Decoration.mark({ class: 'cm-frontmatter' }))
  }

  return builder.finish()
}

const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return buildFrontmatterDecorations(state)
  },
  update(value, tr) {
    if (tr.docChanged) return buildFrontmatterDecorations(tr.state)
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ---------------------------------------------------------------------------
// Inline decorations ViewPlugin
// ---------------------------------------------------------------------------

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private view: EditorView
    private allDecorations: DecorationSet // cached full set (no cursor filtering)

    constructor(view: EditorView) {
      this.view = view
      this.allDecorations = buildAllDecorations(view)
      this.decorations = filterForCursorLine(this.allDecorations, view.state)
      // Register callback for async image loads to trigger rebuild
      imageLoadCallback = () => {
        try {
          this.allDecorations = buildAllDecorations(this.view)
          this.decorations = filterForCursorLine(this.allDecorations, this.view.state)
          this.view.dispatch({})
        } catch {
          // View may be destroyed or not yet ready
        }
      }
    }

    update(update: any) {
      if (update.docChanged || update.viewportChanged) {
        this.view = update.view
        this.allDecorations = buildAllDecorations(update.view)
        this.decorations = filterForCursorLine(this.allDecorations, update.view.state)
      } else if (update.selectionSet) {
        this.view = update.view
        // CHEAP: only refilter, don't rebuild
        this.decorations = filterForCursorLine(this.allDecorations, update.view.state)
      }
    }

    destroy() {
      if (imageLoadCallback === this.rebuildDecorations) {
        imageLoadCallback = null
      }
    }

    private rebuildDecorations = () => {
      this.allDecorations = buildAllDecorations(this.view)
      this.decorations = filterForCursorLine(this.allDecorations, this.view.state)
    }
  },
  {
    decorations: (v) => v.decorations,
  },
)

// ---------------------------------------------------------------------------
// Theme for live preview elements
// ---------------------------------------------------------------------------

const livePreviewStyles = EditorView.baseTheme({
  // Headings
  '.cm-heading': {
    fontFamily: 'var(--font-sans, system-ui, sans-serif)',
    fontWeight: '600',
    lineHeight: '1.3',
    color: 'var(--color-text-primary, #e4e4e7)',
  },
  '.cm-heading-1': { fontSize: '1.6em', marginTop: '0.5em' },
  '.cm-heading-2': { fontSize: '1.35em', marginTop: '0.4em' },
  '.cm-heading-3': { fontSize: '1.15em', marginTop: '0.3em' },
  '.cm-heading-4': { fontSize: '1.05em' },
  '.cm-heading-5': { fontSize: '1em' },
  '.cm-heading-6': { fontSize: '0.9em', color: 'var(--color-text-secondary, #a1a1aa)' },

  // Inline formatting
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through', opacity: '0.6' },
  '.cm-inline-code': {
    backgroundColor: 'var(--color-surface-2, #27272a)',
    padding: '1px 4px',
    borderRadius: '2px',
    fontSize: '0.9em',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },

  // Links
  '.cm-link-text': {
    color: 'var(--color-accent, #71717a)',
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-link-widget': {
    color: 'var(--color-accent, #71717a)',
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
    '&:hover': {
      color: 'var(--color-text-primary, #e4e4e7)',
    },
  },

  // Wiki-links
  '.cm-wikilink-widget': {
    color: 'var(--color-accent, #71717a)',
    backgroundColor: 'var(--color-surface-2, #27272a)',
    padding: '0 5px',
    borderRadius: '2px',
    fontSize: '0.9em',
    cursor: 'pointer',
  },

  // Horizontal rule
  '.cm-hr-widget': {
    border: 'none',
    borderTop: '1px solid var(--color-border, #27272a)',
    margin: '12px 0',
  },

  // Checkbox
  '.cm-checkbox-widget': {
    margin: '0 4px 0 0',
    verticalAlign: 'middle',
    accentColor: 'var(--color-accent, #71717a)',
  },

  // Image
  '.cm-image-widget': {
    margin: '4px 0',
  },
  '.cm-image-placeholder': {
    padding: '8px 12px',
    color: 'var(--color-text-tertiary, #52525b)',
    fontSize: '11px',
    fontStyle: 'italic',
    border: '1px dashed var(--color-border, #27272a)',
    borderRadius: '2px',
  },

  // Blockquote
  '.cm-blockquote': {
    borderLeft: '2px solid var(--color-border, #27272a)',
    paddingLeft: '8px',
    color: 'var(--color-text-secondary, #a1a1aa)',
    fontStyle: 'italic',
  },

  // Code block
  '.cm-codeblock': {
    backgroundColor: 'var(--color-surface-1, #18181b)',
    borderRadius: '2px',
  },

  // Frontmatter (raw fallback)
  '.cm-frontmatter': {
    color: 'var(--color-text-tertiary, #52525b)',
    fontStyle: 'italic',
  },

})

// ---------------------------------------------------------------------------
// List hanging indent — wrapped lines align with text, not the bullet
// ---------------------------------------------------------------------------

const listLineRegex = /^(\s*)([-*+]|\d+[.)]) /

const listIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = buildListIndent(view) }
    update(update: any) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildListIndent(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

function buildListIndent(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      const match = line.text.match(listLineRegex)
      if (match) {
        // indent = leading whitespace + marker + space
        const indent = match[0].length
        builder.add(line.from, line.from, Decoration.line({
          attributes: { style: `padding-left: ${indent}ch; text-indent: -${indent}ch` },
        }))
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function livePreview(filePath?: string): Extension {
  return [
    filePath ? currentFileFacet.of(filePath) : [],
    frontmatterField,
    livePreviewPlugin,
    listIndentPlugin,
    livePreviewStyles,
  ]
}
