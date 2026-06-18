import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Search, GitBranch, Circle } from 'lucide-react'
import { useAgentStore } from '@/store/agent'

// "/" quick-switcher for the Agents pane — fuzzy-find an agent by name and jump
// to it. Lists live sessions (selectable) + parked roles (revive-on-pick).
// Works in both the list and org-chart views (it's a modal overlay).

interface Entry { id?: string; key?: string; title: string; kind: 'session' | 'parked'; status?: string; isFork?: boolean }

export function AgentQuickSwitcher() {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const close = useAgentStore((s) => s.closeAgentSwitcher)
  const sessions = useAgentStore((s) => s.sessions)
  const roles = useAgentStore((s) => s.agentRoles)
  const selectSession = useAgentStore((s) => s.selectSession)
  const reviveAgent = useAgentStore((s) => s.reviveAgent)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const entries = useMemo<Entry[]>(() => {
    const live = sessions.filter((s) => s.status !== 'ended')
    const liveKeys = new Set(live.map((s) => s.agentKey).filter(Boolean) as string[])
    const sessionEntries: Entry[] = live.map((s) => ({
      id: s.id, title: s.name || s.id, kind: 'session', status: s.status, isFork: /\s\(fork\)$/.test(s.name || ''),
    }))
    const parkedEntries: Entry[] = roles
      .filter((r) => !r.folder && r.key !== 'al' && !liveKeys.has(r.key))
      .map((r) => ({ key: r.key, title: r.title, kind: 'parked' as const }))
    return [...sessionEntries, ...parkedEntries]
  }, [sessions, roles])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [...entries].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
    return entries
      .map((e) => ({ e, score: fuzzyScore(e.title.toLowerCase(), q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.e.title.localeCompare(b.e.title))
      .map((x) => x.e)
  }, [entries, query])

  useEffect(() => { if (sel >= results.length) setSel(Math.max(0, results.length - 1)) }, [results.length, sel])
  useEffect(() => { (listRef.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const pick = useCallback((e: Entry | undefined) => {
    if (!e) return
    if (e.kind === 'session' && e.id) {
      selectSession(e.id)
    } else if (e.kind === 'parked' && e.key) {
      useAgentStore.setState({ pendingSessionActivate: true }) // open the revived agent when it spawns
      reviveAgent(e.key)
    }
    close()
  }, [selectSession, reviveAgent, close])

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) { ev.preventDefault(); setSel((i) => Math.min(i + 1, results.length - 1)) }
    else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) { ev.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(results[sel]) }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() }
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
            placeholder="Jump to agent…"
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && <div className="px-3 py-6 text-center text-xs text-text-tertiary">No agents match</div>}
          {results.map((e, i) => (
            <button
              key={e.id ?? e.key}
              onClick={() => pick(e)}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${i === sel ? 'bg-surface-2' : 'hover:bg-surface-1'}`}
            >
              {e.isFork && <GitBranch size={11} className="flex-shrink-0 text-violet-400/70" />}
              <span className="flex-1 truncate text-text-primary">{e.title.replace(/\s\(fork\)$/, '')}</span>
              {e.kind === 'session' && e.status === 'running' && <Circle size={6} className="flex-shrink-0 fill-current text-warning" />}
              {e.kind === 'parked' && <span className="flex-shrink-0 text-[10px] text-text-tertiary">parked · revive</span>}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-text-tertiary">↑↓ navigate · ↵ jump · esc close</div>
      </div>
    </div>
  )
}

function rank(e: Entry): number {
  if (e.title === 'Al') return 0
  if (e.kind === 'session') return 1
  return 2
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
