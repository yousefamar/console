// A kanban card's editing modal hosted OUTSIDE Spaces (the Inbox's review
// strip). The spaces store binds every board mutation to the ACTIVE board, so
// this host owns its own copy of ONE project's board: read via /notes/file/,
// write via POST /board/:project/:verb (same verbs + bodies the store sends),
// re-read after every write. No optimistic edits — the board isn't on screen,
// the modal re-renders from the canonical copy.
import { useCallback, useEffect, useState } from 'react'
import { hubFetch } from '@/hub'
import { showAlert } from '@/dialog'
import { findCardByQuery, parseBoard, type BoardCard, type CardRef, type KanbanBoard } from '@/kanban/board'
import { useSpacesStore } from '@/store/spaces'
import { useAgentStore } from '@/store/agent'
import { hubErrorText } from '@/inbox/approve'
import { CardDetailModal, assignableFor } from '@/components/SpacesTab'

interface Props {
  slug: string
  /** `^id` when stamped, else exact card text — the /board/* address. */
  query: string
  onClose: () => void
}

export function InboxCardModal({ slug, query, onClose }: Props) {
  const boardPath = useSpacesStore((s) => s.spaces.find((sp) => sp.slug === slug)?.boardPath ?? null)
  const sessions = useAgentStore((s) => s.sessions)
  const [board, setBoard] = useState<KanbanBoard | null>(null)
  const [hit, setHit] = useState<{ ref: CardRef; card: BoardCard } | null>(null)
  // An edit can rename an unstamped card — track the address we re-find by.
  const [address, setAddress] = useState(query)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (addr: string): Promise<boolean> => {
    if (!boardPath) { setError('This project has no board.'); return false }
    try {
      const { content } = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(boardPath)}`, { timeoutMs: 10000 })
      const b = parseBoard(content)
      const h = findCardByQuery(b, addr)
      setBoard(b)
      setHit(h)
      if (!h) setError('That card is no longer on the board.')
      return !!h
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }, [boardPath])

  useEffect(() => { void reload(address) }, [reload, address])

  const post = async (verb: string, body: Record<string, unknown>, nextAddress = address) => {
    try {
      await hubFetch(`/board/${encodeURIComponent(slug)}/${verb}`, { method: 'POST', body: JSON.stringify({ card: address, ...body }), timeoutMs: 10000 })
    } catch (e) {
      void showAlert(`Board update failed: ${hubErrorText(e)}`)
      await reload(address)
      return
    }
    if (nextAddress !== address) setAddress(nextAddress)
    else await reload(address)
    // Keep the Spaces pane honest if it happens to show this board.
    const st = useSpacesStore.getState()
    if (st.activeSlug === slug) void st.loadBoard()
    void st.refreshSpaces()
  }

  if (!board || !hit) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="rounded-lg border border-border bg-surface-0 px-4 py-3 text-xs text-text-tertiary shadow-xl" onClick={(e) => e.stopPropagation()}>
          {error ?? 'Loading card…'}
        </div>
      </div>
    )
  }

  const { ref, card } = hit
  const liveKeyed = sessions.filter((x) => x.status !== 'ended' && x.agentKey)
  return (
    <CardDetailModal
      key={card.blockId ?? `${ref.column}:${ref.index}`}
      card={card}
      columnTitles={board.columns.map((c) => c.title)}
      currentColumn={ref.column}
      assignable={assignableFor(liveKeyed, slug)}
      onClose={onClose}
      onEditContent={(text, detail) => {
        const t = text.trim()
        void post('edit', { text: t, detail: detail.map((l) => l.trim()).filter(Boolean) }, card.blockId ? address : t)
      }}
      onAssignKey={(key) => void post('assign', { agent: key })}
      onToggleBlockedNow={() => void post('block', { blocked: !card.blocked })}
      onToggleNoforkNow={() => void post('nofork', { nofork: !card.nofork })}
      onToggleInheritNow={() => void post('inherit', { inherit: !card.inherit })}
      onSetModel={(m) => void post('model', { model: m })}
      onMoveColumn={(to) => void post('move', { to })}
      onDelete={() => { onClose(); void post('remove', {}) }}
    />
  )
}
