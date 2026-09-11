// Console-wide command bar — jump to ANYTHING from ANYWHERE: a pane, a space,
// an agent session, a vault file, a chat room, a mail thread, a feed, a
// bookmark, an upcoming calendar event, or a handful of actions. Opened with
// `\` on any pane (and `/` on Spaces, where it replaced the Spaces-only
// switcher). Quick-switcher conventions: fuzzy match, ↑↓/Ctrl+n/p, ↵, esc.
// Ranking lives in `@/commandbar/rank` (pure, unit-tested).

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import {
  Search, Bot, GitBranch, FileText, FolderKanban, Tag, Circle, Plus, Mail, MessageCircle, Rss, Bookmark,
  CalendarDays, LayoutDashboard, Inbox, MapPin, PoundSterling, Zap,
} from 'lucide-react'
import { db } from '@/db'
import { useUiStore, type ActivePane } from '@/store/ui'
import { useSpacesStore, focusSessionInSpaces } from '@/store/spaces'
import { VAULT_SLUG, UNASSIGNED_SLUG } from '@/spaces/scope'
import { useAgentStore } from '@/store/agent'
import { useNotesStore } from '@/store/notes'
import { useChatStore } from '@/store/chat'
import { useInboxStore } from '@/store/inbox'
import { useFeedStore } from '@/store/feeds'
import { useBookmarkStore } from '@/store/bookmarks'
import { useCalendarStore } from '@/store/calendar'
import { useFinanceStore, type MoneySubTab } from '@/store/finance'
import { openVaultFile } from '@/notes/open-subscribe'
import { rankEntries, launcherSection, type Rankable, type CommandKind } from '@/commandbar/rank'
import type { DbChatRoom } from '@/matrix/types'
import type { DbThread } from '@/gmail/types'
import type { DbCalendarEvent } from '@/calendar/types'
import { relativeTime, formatDate } from '@/utils/date'

interface Entry extends Rankable {
  isFork?: boolean
  running?: boolean
  unread?: boolean
  pick: () => void
}

/** Kinds whose recency is a real "last touched" moment worth printing. */
const TIMESTAMPED: ReadonlySet<CommandKind> = new Set(['session', 'file', 'room', 'thread'])
const FILE_CAP = 2000
const RECENT_THREADS = 200
const THREAD_HITS = 30
const UPCOMING_DAYS = 60
const DAY = 86_400_000

const PANES: { pane: ActivePane; title: string; icon: React.ReactNode }[] = [
  { pane: 'home', title: 'Home', icon: <LayoutDashboard size={11} /> },
  { pane: 'inbox', title: 'Inbox', icon: <Inbox size={11} /> },
  { pane: 'email', title: 'Mail', icon: <Mail size={11} /> },
  { pane: 'calendar', title: 'Calendar', icon: <CalendarDays size={11} /> },
  { pane: 'chat', title: 'Chat', icon: <MessageCircle size={11} /> },
  { pane: 'spaces', title: 'Spaces', icon: <FolderKanban size={11} /> },
  { pane: 'feeds', title: 'Feeds', icon: <Rss size={11} /> },
  { pane: 'notes', title: 'Notes', icon: <FileText size={11} /> },
  { pane: 'bookmarks', title: 'Bookmarks', icon: <Bookmark size={11} /> },
  { pane: 'map', title: 'Map', icon: <MapPin size={11} /> },
  { pane: 'money', title: 'Money', icon: <PoundSterling size={11} /> },
]

const MONEY_TABS: { id: MoneySubTab; title: string }[] = [
  { id: 'cashflow', title: 'Cashflow' },
  { id: 'networth', title: 'Net worth' },
  { id: 'budgets', title: 'Budgets' },
  { id: 'scenarios', title: 'Scenarios' },
  { id: 'categories', title: 'Categories' },
  { id: 'transactions', title: 'Transactions' },
]

export function CommandBar() {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [rooms, setRooms] = useState<DbChatRoom[]>([])
  const [recentThreads, setRecentThreads] = useState<DbThread[]>([])
  const [threadHits, setThreadHits] = useState<DbThread[]>([])
  const [upcoming, setUpcoming] = useState<DbCalendarEvent[]>([])
  const close = useCallback(() => useUiStore.getState().setCommandBarOpen(false), [])
  const spaces = useSpacesStore((s) => s.spaces)
  const sessions = useAgentStore((s) => s.sessions)
  const files = useNotesStore((s) => s.files)
  const openedAt = useNotesStore((s) => s.openedAt)
  const feeds = useFeedStore((s) => s.feeds)
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Sources that only load when their pane mounts — prime them so the bar is
  // complete from a cold boot on any pane. Each is idempotent / hub-cached.
  useEffect(() => {
    const notes = useNotesStore.getState()
    if (!notes.adapter) void notes.reconnectVault()
    const bm = useBookmarkStore.getState()
    if (bm.bookmarks.length === 0 && !bm.loading) void bm.fetchBookmarks()
    const fd = useFeedStore.getState()
    if (fd.feeds.length === 0 && !fd.loading) void fd.fetchFeeds()
  }, [])

  // Dexie-backed sources: one read per open. Threads are capped to the recent
  // set here; a typed query additionally searches the whole table below.
  useEffect(() => {
    let alive = true
    void db.chatRooms.toArray().then((r) => { if (alive) setRooms(r) })
    void db.threads.orderBy('date').reverse().limit(RECENT_THREADS).toArray().then((t) => { if (alive) setRecentThreads(t) })
    // Still-running or future only: the index is on startTime, so read from
    // yesterday and drop anything that has already ended.
    const now = Date.now()
    const from = new Date(now - DAY).toISOString()
    const to = new Date(now + UPCOMING_DAYS * DAY).toISOString()
    void db.calendarEvents.where('startTime').between(from, to).toArray().then((evs) => {
      if (!alive) return
      const seen = new Set<string>()
      setUpcoming(evs.filter((ev) => ev.status !== 'cancelled' && new Date(ev.endTime).getTime() > now && !seen.has(ev.id) && seen.add(ev.id)))
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) { setThreadHits([]); return }
    let alive = true
    const timer = setTimeout(() => {
      void db.threads
        .filter((t) => t.subject.toLowerCase().includes(q) || t.from.toLowerCase().includes(q) || t.snippet.toLowerCase().includes(q))
        .limit(THREAD_HITS)
        .toArray()
        .then((hits) => { if (alive) setThreadHits(hits) })
    }, 120)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    const ui = () => useUiStore.getState()
    const go = (pane: ActivePane) => ui().setActivePane(pane)
    const spaceRecency = new Map<string, number>()
    const bumpSpace = (slug: string | null, ts: number) => {
      if (slug && ts > (spaceRecency.get(slug) ?? 0)) spaceRecency.set(slug, ts)
    }

    for (const p of PANES) {
      out.push({ key: `p:${p.pane}`, title: p.title, kind: 'pane', recency: 0, pick: () => go(p.pane) })
    }
    for (const t of MONEY_TABS) {
      out.push({
        key: `p:money:${t.id}`, title: t.title, hint: 'Money', kind: 'pane', recency: 0,
        pick: () => { go('money'); useFinanceStore.getState().setSubTab(t.id) },
      })
    }

    out.push({ key: 'a:compose', title: 'Compose email', kind: 'action', recency: 0, pick: () => { go('email'); ui().setShowCompose(true) } })
    out.push({ key: 'a:event', title: 'New calendar event', kind: 'action', recency: 0, pick: () => { go('calendar'); useCalendarStore.getState().openCreateForm() } })
    out.push({ key: 'a:bookmark', title: 'Add bookmark', kind: 'action', recency: 0, pick: () => { go('bookmarks'); useBookmarkStore.getState().enterAddMode() } })
    out.push({ key: 'a:feed', title: 'Add feed', kind: 'action', recency: 0, pick: () => { go('feeds'); useFeedStore.getState().setShowAddModal(true) } })
    out.push({ key: 'a:dark', title: 'Toggle dark mode', kind: 'action', recency: 0, pick: () => ui().toggleDarkMode() })
    out.push({ key: 'a:keys', title: 'Keyboard shortcuts', kind: 'action', recency: 0, pick: () => ui().setShowKeybindingHelp(true) })

    for (const s of sessions) {
      if (s.status === 'ended') continue
      const slug = s.project ?? s.areas?.[0] ?? null
      const recency = s.lastActivityAt ?? s.createdAt
      bumpSpace(slug, recency)
      out.push({
        key: `s:${s.id}`,
        title: (s.name || s.id).replace(/\s\(fork\)$/, ''),
        hint: slug ?? undefined,
        kind: 'session',
        recency,
        isFork: !!s.parentClaudeSessionId || /\s\(fork\)$/.test(s.name || ''),
        running: s.status === 'running',
        unread: s.hasUnread,
        pick: () => { void focusSessionInSpaces(s.id) },
      })
    }
    for (const f of files.slice(0, FILE_CAP)) {
      const slug = f.path.match(/^projects\/([^/.]+)/)?.[1] ?? null
      const recency = Math.max(f.mtime, openedAt[f.path] ?? 0)
      bumpSpace(slug, recency)
      out.push({ key: `f:${f.path}`, title: f.name, hint: f.dir || undefined, kind: 'file', recency, pick: () => { void openVaultFile(f.path) } })
    }
    for (const r of rooms) {
      out.push({
        key: `r:${r.id}`, title: r.name, hint: r.isDirect ? undefined : 'group', kind: 'room', recency: r.lastMessageTime ?? 0, unread: r.isUnread,
        pick: () => { go('chat'); void useChatStore.getState().selectRoom(r.id) },
      })
    }
    const threadIds = new Set<string>()
    for (const t of [...recentThreads, ...threadHits]) {
      if (threadIds.has(t.id)) continue
      threadIds.add(t.id)
      out.push({
        key: `t:${t.id}`, title: t.subject || '(no subject)', hint: t.from, kind: 'thread', recency: t.date, unread: t.isUnread,
        pick: () => { go('email'); void useInboxStore.getState().selectThread(t.id) },
      })
    }
    for (const fd of feeds) {
      out.push({
        key: `fd:${fd.id}`, title: fd.title, hint: fd.folder ?? undefined, kind: 'feed', recency: 0,
        pick: () => { go('feeds'); useFeedStore.getState().selectFeed(fd.id) },
      })
    }
    for (const b of bookmarks) {
      let host: string | undefined
      try { host = new URL(b.url).hostname.replace(/^www\./, '') } catch { host = undefined }
      out.push({
        key: `b:${b.filename}`, title: b.title, hint: host, kind: 'bookmark', recency: 0,
        pick: () => { go('bookmarks'); useBookmarkStore.getState().selectBookmark(b.filename) },
      })
    }
    for (const ev of upcoming) {
      const start = new Date(ev.startTime).getTime()
      out.push({
        key: `e:${ev.compoundKey}`, title: ev.summary || '(untitled)', hint: ev.allDay ? new Date(ev.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : formatDate(start), kind: 'event', recency: start,
        pick: () => {
          go('calendar')
          const cal = useCalendarStore.getState()
          // All-day rows store a bare date; parse it as local noon, not UTC midnight.
          cal.navigateToDate(ev.allDay ? new Date(ev.startTime + 'T12:00:00') : new Date(start))
          void cal.loadEventsFromDb().then(() => useCalendarStore.getState().selectEvent(ev.id))
        },
      })
    }

    out.push({ key: 'sp:~vault', title: 'Vault', kind: 'project', recency: 1, pick: () => { go('spaces'); useSpacesStore.getState().selectSpace(VAULT_SLUG) } })
    out.push({ key: 'sp:~unassigned', title: 'Unassigned', kind: 'project', recency: 0, pick: () => { go('spaces'); useSpacesStore.getState().selectSpace(UNASSIGNED_SLUG) } })
    for (const sp of spaces) {
      out.push({
        key: `sp:${sp.slug}`, title: sp.title, kind: sp.kind, recency: spaceRecency.get(sp.slug) ?? 0,
        pick: () => { go('spaces'); useSpacesStore.getState().selectSpace(sp.slug) },
      })
    }
    return out
  }, [spaces, sessions, files, openedAt, rooms, recentThreads, threadHits, feeds, bookmarks, upcoming])

  const results = useMemo(() => {
    const ranked = rankEntries(entries, query)
    const q = query.trim()
    if (!q) return ranked
    // Trailing create-note escape hatch — the new-note form lives on Spaces,
    // pre-filled with the query as title, defaulting into the active project.
    ranked.push({
      key: '~create',
      title: `New note: “${q}”`,
      kind: 'create',
      recency: 0,
      pick: () => {
        useUiStore.getState().setActivePane('spaces')
        const active = useSpacesStore.getState().activeSlug
        useNotesStore.getState().openNewFileForm(active && !active.startsWith('~') ? `projects/${active}` : 'scratch', q)
      },
    })
    return ranked
  }, [entries, query])

  const launcher = !query.trim()

  useEffect(() => { if (sel >= results.length) setSel(Math.max(0, results.length - 1)) }, [results.length, sel])
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const pick = useCallback((e: Entry | undefined) => {
    if (!e) return
    close()
    e.pick()
  }, [close])

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) { ev.preventDefault(); setSel((i) => Math.min(i + 1, results.length - 1)) }
    else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) { ev.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(results[sel]) }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() }
  }

  const iconFor = (e: Entry) => {
    const c = 'flex-shrink-0 text-text-tertiary'
    switch (e.kind) {
      case 'pane': return <span className={c}>{PANES.find((p) => `p:${p.pane}` === e.key)?.icon ?? <PoundSterling size={11} />}</span>
      case 'action': return <Zap size={11} className={c} />
      case 'area': return <Tag size={11} className={c} />
      case 'project': return <FolderKanban size={11} className={c} />
      case 'file': return <FileText size={11} className={c} />
      case 'room': return <MessageCircle size={11} className={c} />
      case 'thread': return <Mail size={11} className={c} />
      case 'feed': return <Rss size={11} className={c} />
      case 'bookmark': return <Bookmark size={11} className={c} />
      case 'event': return <CalendarDays size={11} className={c} />
      case 'create': return <Plus size={11} className={c} />
      case 'session': return e.isFork ? <GitBranch size={11} className="flex-shrink-0 text-violet-400/70" /> : <Bot size={11} className={c} />
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-0 md:pt-[15vh]" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="w-full max-w-lg overflow-hidden border border-border bg-surface-0 shadow-xl md:mx-4 md:rounded-lg">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="flex-shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0) }}
            onKeyDown={onKeyDown}
            placeholder="Jump to anything…"
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1 md:max-h-[50vh]">
          {results.length === 0 && <div className="px-3 py-6 text-center text-xs text-text-tertiary">Nothing matches</div>}
          {results.map((e, i) => {
            const section = launcher ? launcherSection(e.kind) : null
            const showHeader = section && (i === 0 || launcherSection(results[i - 1]!.kind) !== section)
            return (
              <div key={e.key}>
                {showHeader && <div className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-text-tertiary">{section}</div>}
                <button
                  data-idx={i}
                  data-kind={e.kind}
                  onClick={() => pick(e)}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${i === sel ? 'bg-surface-2' : 'hover:bg-surface-1'}`}
                >
                  {iconFor(e)}
                  <span className="truncate text-text-primary">{e.title}</span>
                  {e.hint && <span className="truncate text-[10px] text-text-tertiary">{e.hint}</span>}
                  <span className="flex-1" />
                  {e.unread && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-500" />}
                  {e.running && <Circle size={6} className="flex-shrink-0 fill-current text-warning" />}
                  {!launcher && e.recency > 0 && TIMESTAMPED.has(e.kind) && <span className="flex-shrink-0 text-[10px] text-text-tertiary">{relativeTime(e.recency)}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-text-tertiary">↑↓ navigate · ↵ jump · esc close</div>
      </div>
    </div>
  )
}
