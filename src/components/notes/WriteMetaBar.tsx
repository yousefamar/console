// Structured frontmatter editor shown above the editor for blog drafts and
// published posts. Title input, tag chips with autocomplete, project select.
// All edits round-trip through the CM6 buffer (single writer — the editor's
// save flow persists them), via a transaction replacing only the frontmatter.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Tag, X } from 'lucide-react'
import { useNotesStore } from '@/store/notes'
import { useBlogStore } from '@/store/blog'
import { parseFrontmatter, stampFrontmatter, frontmatterRange } from '@/utils/frontmatter'

interface Props {
  path: string
}

const COLLAPSE_KEY = 'console:notes:metaBarCollapsed'

export function WriteMetaBar({ path }: Props) {
  const content = useNotesStore((s) => s.openFiles[path]?.content ?? '')
  const allTags = useBlogStore((s) => s.tags)
  const projects = useBlogStore((s) => s.projects)

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === 'true')
  useEffect(() => { localStorage.setItem(COLLAPSE_KEY, String(collapsed)) }, [collapsed])

  const fm = useMemo(() => parseFrontmatter(content).fm, [content])

  // Local title state so typing isn't fighting the round-trip; synced on blur
  // or after a debounce.
  const [titleDraft, setTitleDraft] = useState(fm.title ?? '')
  const titleDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setTitleDraft(fm.title ?? '') }, [fm.title, path])

  const [tagQuery, setTagQuery] = useState('')
  const [tagFocus, setTagFocus] = useState(false)

  // ---------------------------------------------------------------------
  // Stamp helper — apply a frontmatter change to the live editor buffer.
  // Uses a CM6 transaction when the editor view is mounted (preserves undo
  // + cursor); falls back to updateFileContent otherwise.
  // ---------------------------------------------------------------------
  const applyStamp = (updates: Record<string, string | boolean | string[]>) => {
    const cur = useNotesStore.getState().openFiles[path]?.content ?? ''
    const next = stampFrontmatter(cur, updates)
    if (next === cur) return
    const view = useNotesStore.getState().editorView
    if (view && view.state.doc.toString() === cur) {
      const oldRange = frontmatterRange(cur)
      const newRange = frontmatterRange(next)
      if (oldRange && newRange) {
        view.dispatch({
          changes: { from: oldRange.from, to: oldRange.to, insert: next.slice(newRange.from, newRange.to) },
        })
        return
      }
    }
    useNotesStore.getState().updateFileContent(path, next)
  }

  const commitTitle = (value: string) => {
    if (titleDebounce.current) { clearTimeout(titleDebounce.current); titleDebounce.current = null }
    const trimmed = value.trim()
    if (trimmed && trimmed !== fm.title) applyStamp({ title: trimmed })
  }

  const onTitleChange = (value: string) => {
    setTitleDraft(value)
    if (titleDebounce.current) clearTimeout(titleDebounce.current)
    titleDebounce.current = setTimeout(() => commitTitle(value), 800)
  }

  const tags = fm.tags ?? []

  const addTag = (tag: string) => {
    const t = tag.trim()
    if (!t || tags.includes(t)) { setTagQuery(''); return }
    applyStamp({ tags: [...tags, t] })
    setTagQuery('')
  }

  const removeTag = (tag: string) => {
    applyStamp({ tags: tags.filter((t) => t !== tag) })
  }

  const setProject = (slug: string) => {
    applyStamp({ project: slug })
  }

  const tagSuggestions = useMemo(() => {
    if (!tagFocus) return []
    const q = tagQuery.toLowerCase()
    return allTags
      .filter((t) => !tags.includes(t))
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, 8)
  }, [tagFocus, tagQuery, allTags, tags])

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="flex items-center gap-2 w-full px-3 py-1 border-b border-border text-left hover:bg-surface-1 transition-colors"
        title="Expand post metadata"
      >
        <ChevronDown size={10} className="text-text-tertiary shrink-0" />
        <span className="text-[10px] text-text-secondary truncate">{fm.title || '(untitled)'}</span>
        {tags.length > 0 && (
          <span className="text-[10px] text-text-tertiary truncate">{tags.join(' · ')}</span>
        )}
        {fm.project && <span className="text-[10px] text-text-tertiary shrink-0">@{fm.project}</span>}
      </button>
    )
  }

  return (
    <div className="border-b border-border px-3 py-2 space-y-1.5 bg-surface-1/50">
      {/* Title row */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={titleDraft}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={(e) => commitTitle(e.target.value)}
          placeholder="Post title…"
          className="flex-1 bg-transparent text-sm font-medium text-text-primary placeholder:text-text-tertiary outline-none min-w-0"
        />
        <button
          onClick={() => setCollapsed(true)}
          className="text-text-tertiary hover:text-text-primary transition-colors shrink-0"
          title="Collapse"
        >
          <ChevronUp size={12} />
        </button>
      </div>

      {/* Tags + project row */}
      <div className="flex items-center gap-1.5 flex-wrap relative">
        <Tag size={10} className="text-text-tertiary shrink-0" />
        {tags.map((t) => (
          <span
            key={t}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-surface-2 text-text-secondary rounded-sm"
          >
            {t}
            <button
              onClick={() => removeTag(t)}
              className="text-text-tertiary hover:text-text-primary"
              aria-label={`Remove tag ${t}`}
            >
              <X size={8} />
            </button>
          </span>
        ))}
        <div className="relative">
          <input
            type="text"
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            onFocus={() => setTagFocus(true)}
            onBlur={() => setTimeout(() => setTagFocus(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagQuery.trim()) {
                e.preventDefault()
                addTag(tagQuery)
              } else if (e.key === 'Backspace' && !tagQuery && tags.length) {
                removeTag(tags[tags.length - 1]!)
              }
            }}
            placeholder={tags.length ? '+' : 'add tags…'}
            className="bg-transparent text-[10px] text-text-primary placeholder:text-text-tertiary outline-none w-16"
          />
          {tagSuggestions.length > 0 && (
            <div className="absolute top-full left-0 mt-1 bg-surface-0 border border-border rounded-sm shadow-lg z-20 min-w-28 max-h-48 overflow-y-auto">
              {tagSuggestions.map((t) => (
                <button
                  key={t}
                  onMouseDown={(e) => { e.preventDefault(); addTag(t) }}
                  className="block w-full text-left px-2 py-1 text-[10px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        <select
          value={fm.project ?? ''}
          onChange={(e) => setProject(e.target.value)}
          className="bg-surface-0 border border-border rounded-sm text-[10px] text-text-secondary px-1 py-0.5 outline-none cursor-pointer max-w-32"
          title="Project (devlog)"
        >
          <option value="">no project</option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>{p.title}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
