// "/" command bar for the Spaces pane — jump to ANYTHING: an area, a project,
// an agent session (live or parked), or a vault file. Follows the
// AgentQuickSwitcher modal conventions (fuzzy subsequence match, ↑↓/↵/esc);
// empty query sorts by RECENCY (session activity ts / file mtime / space of
// the most recent thing in it).

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Search, Bot, GitBranch, FileText, FolderKanban, Tag, Circle } from 'lucide-react'
import { useSpacesStore } from '@/store/spaces'
import { useAgentStore } from '@/store/agent'
import { useNotesStore } from '@/store/notes'

interface Entry {
  key: string
  title: string
  /** Secondary label (space slug / dir). */
  hint?: string
  kind: 'area' | 'project' | 'session' | 'parked' | 'file'
  recency: number
  isFork?: boolean
  running?: boolean
  pick: () => void
}

const FILE_CAP = 2000 // fuzzy over the whole vault is fine; render is capped anyway

export function SpacesQuickSwitcher() {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const close = useSpacesStore((s) => s.closeSwitcher)
  const spaces = useSpacesStore((s) => s.spaces)
  const selectSpace = useSpacesStore((s) => s.selectSpace)
  const setActiveView = useSpacesStore((s) => s.setActiveView)
  const sessions = useAgentStore((s) => s.sessions)
  const roles = useAgentStore((s) => s.agentRoles)
  const files = useNotesStore((s) => s.files)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    const spaceOf = (r: { project?: string | null; areas?: string[] }) => r.project ?? r.areas?.[0] ?? null
    const roleByKey = new Map(roles.map((r) => [r.key, r]))
    const spaceRecency = new Map<string, number>()
    const bumpSpace = (slug: string | null, ts: number) => {
      if (slug && ts > (spaceRecency.get(slug) ?? 0)) spaceRecency.set(slug, ts)
    }

    // Agent sessions (live) — recency = createdAt (best available activity signal).
    const liveKeys = new Set<string>()
    for (const s of sessions) {
      if (s.status === 'ended') continue
      if (s.agentKey) liveKeys.add(s.agentKey)
      const role = s.agentKey ? roleByKey.get(s.agentKey) : undefined
      const slug = role ? spaceOf(role) : null
      bumpSpace(slug, s.createdAt)
      out.push({
        key: `s:${s.id}`,
        title: (s.name || s.id).replace(/\s\(fork\)$/, ''),
        hint: slug ?? undefined,
        kind: 'session',
        recency: s.createdAt,
        isFork: !!role?.fork || /\s\(fork\)$/.test(s.name || ''),
        running: s.status === 'running',
        pick: () => {
          if (slug) selectSpace(slug)
          useAgentStore.getState().selectSession(s.id)
        },
      })
    }
    // Parked roles.
    for (const r of roles) {
      if (r.folder || liveKeys.has(r.key)) continue
      const slug = spaceOf(r)
      out.push({
        key: `p:${r.key}`,
        title: r.title,
        hint: slug ? `${slug} · parked` : 'parked',
        kind: 'parked',
        recency: 0,
        isFork: r.fork,
        pick: () => {
          if (slug) selectSpace(slug)
          useAgentStore.setState({ pendingSessionActivate: true })
          useAgentStore.getState().reviveAgent(r.key)
        },
      })
    }
    // Files — the whole vault (not just project files), mtime recency.
    for (const f of files.slice(0, FILE_CAP)) {
      const m = f.path.match(/^projects\/([^/.]+)/)
      const slug = m?.[1] ?? null
      bumpSpace(slug, f.mtime)
      out.push({
        key: `f:${f.path}`,
        title: f.name,
        hint: f.dir || undefined,
        kind: 'file',
        recency: f.mtime,
        pick: () => {
          if (slug) selectSpace(slug)
          void useNotesStore.getState().openFile(f.path)
          setActiveView('docs')
        },
      })
    }
    // Spaces — recency inherited from their most recent session/file.
    for (const sp of spaces) {
      out.push({
        key: `sp:${sp.slug}`,
        title: sp.title,
        kind: sp.kind,
        recency: spaceRecency.get(sp.slug) ?? 0,
        pick: () => selectSpace(sp.slug),
      })
    }
    return out
  }, [spaces, sessions, roles, files, selectSpace, setActiveView])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [...entries].sort((a, b) => b.recency - a.recency).slice(0, 40)
    return entries
      .map((e) => ({ e, score: fuzzyScore(`${e.title} ${e.hint ?? ''}`.toLowerCase(), q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || b.e.recency - a.e.recency)
      .slice(0, 40)
      .map((x) => x.e)
  }, [entries, query])

  useEffect(() => { if (sel >= results.length) setSel(Math.max(0, results.length - 1)) }, [results.length, sel])
  useEffect(() => { (listRef.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const pick = useCallback((e: Entry | undefined) => {
    if (!e) return
    e.pick()
    close()
  }, [close])

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) { ev.preventDefault(); setSel((i) => Math.min(i + 1, results.length - 1)) }
    else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) { ev.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(results[sel]) }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() }
  }

  const iconFor = (e: Entry) => {
    if (e.kind === 'area') return <Tag size={11} className="flex-shrink-0 text-text-tertiary" />
    if (e.kind === 'project') return <FolderKanban size={11} className="flex-shrink-0 text-text-tertiary" />
    if (e.kind === 'file') return <FileText size={11} className="flex-shrink-0 text-text-tertiary" />
    if (e.isFork) return <GitBranch size={11} className="flex-shrink-0 text-violet-400/70" />
    return <Bot size={11} className="flex-shrink-0 text-text-tertiary" />
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="mx-4 w-full max-w-lg overflow-hidden rounded-lg border border-border bg-surface-0 shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="flex-shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0) }}
            onKeyDown={onKeyDown}
            placeholder="Jump to space, agent, file…"
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && <div className="px-3 py-6 text-center text-xs text-text-tertiary">Nothing matches</div>}
          {results.map((e, i) => (
            <button
              key={e.key}
              onClick={() => pick(e)}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${i === sel ? 'bg-surface-2' : 'hover:bg-surface-1'}`}
            >
              {iconFor(e)}
              <span className="truncate text-text-primary">{e.title}</span>
              {e.hint && <span className="truncate text-[10px] text-text-tertiary">{e.hint}</span>}
              <span className="flex-1" />
              {e.running && <Circle size={6} className="flex-shrink-0 fill-current text-warning" />}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-text-tertiary">↑↓ navigate · ↵ jump · esc close</div>
      </div>
    </div>
  )
}

/** Subsequence fuzzy match → score (lower is better), or -1 for no match.
 *  A contiguous substring beats any scattered subsequence. */
function fuzzyScore(text: string, q: string): number {
  const idx = text.indexOf(q)
  if (idx >= 0) return idx
  let ti = 0, qi = 0, first = -1
  while (ti < text.length && qi < q.length) {
    if (text[ti] === q[qi]) { if (first < 0) first = ti; qi++ }
    ti++
  }
  return qi === q.length ? 1000 + first : -1
}
