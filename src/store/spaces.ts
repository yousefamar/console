// Spaces — project-first nav state. A space is a project (folder under
// projects/) or an area (registry tag). Backed by /blog/spaces; boards are
// read/written through /notes/file/ so they stay plain vault markdown.

import { create } from 'zustand'
import { hubFetch } from '@/hub'
import { parseBoard, serializeBoard, moveCard, addCard, refreshCardLine, findCard, type KanbanBoard, type CardRef } from '@/kanban/board'

export interface SpaceSummary {
  kind: 'project' | 'area'
  slug: string
  title: string
  notePath: string | null
  boardPath: string | null
  status: 'active' | 'dormant' | 'complete' | null
  fileCount: number
}

interface SpacesState {
  spaces: SpaceSummary[]
  loading: boolean
  activeSlug: string | null
  /** Centre-pane tab within the active space. Docs IS the vault editor
   *  (absorbing the Notes tab); the file list lives in the drilled rail. */
  activeView: 'board' | 'docs'
  /** Parsed board for the active space (null = no board / not loaded). */
  board: KanbanBoard | null
  boardPath: string | null
  boardMtime: number | null
  boardError: string | null

  refreshSpaces: () => Promise<void>
  selectSpace: (slug: string | null) => void
  setActiveView: (v: 'board' | 'docs') => void
  loadBoard: () => Promise<void>
  /** Persist the current in-memory board back to the vault (conditional write). */
  saveBoard: () => Promise<boolean>
  moveCardTo: (ref: CardRef, toColumn: string) => Promise<void>
  addCardTo: (column: string, text: string, agentKey?: string) => Promise<void>
  assignCard: (ref: CardRef, agentKey: string | null) => Promise<void>
  /** Flip the `#blocked` tag on a card (a property, not a column move). */
  toggleBlocked: (ref: CardRef) => Promise<void>
}

const ACTIVE_SLUG_KEY = 'console:spaces:active'

export const useSpacesStore = create<SpacesState>((set, get) => ({
  spaces: [],
  loading: false,
  activeSlug: localStorage.getItem(ACTIVE_SLUG_KEY),
  activeView: 'board',
  board: null,
  boardPath: null,
  boardMtime: null,
  boardError: null,

  refreshSpaces: async () => {
    set({ loading: true })
    try {
      const { spaces } = await hubFetch<{ spaces: SpaceSummary[] }>('/blog/spaces', { timeoutMs: 15000 })
      set({ spaces, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  selectSpace: (slug) => {
    if (slug) localStorage.setItem(ACTIVE_SLUG_KEY, slug)
    else localStorage.removeItem(ACTIVE_SLUG_KEY)
    set({ activeSlug: slug, board: null, boardPath: null, boardMtime: null, boardError: null })
    if (slug) void get().loadBoard()
  },

  setActiveView: (v) => set({ activeView: v }),

  loadBoard: async () => {
    const { spaces, activeSlug } = get()
    const space = spaces.find((s) => s.slug === activeSlug)
    if (!space?.boardPath) { set({ board: null, boardPath: null }); return }
    try {
      const { content } = await hubFetch<{ content: string }>(`/notes/file/${encodeURIComponent(space.boardPath)}`, { timeoutMs: 10000 })
      set({ board: parseBoard(content), boardPath: space.boardPath, boardError: null })
    } catch (e) {
      set({ boardError: (e as Error).message })
    }
  },

  saveBoard: async () => {
    const { board, boardPath } = get()
    if (!board || !boardPath) return false
    try {
      await hubFetch(`/notes/file/${encodeURIComponent(boardPath)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: serializeBoard(board) }),
        timeoutMs: 10000,
      })
      return true
    } catch (e) {
      set({ boardError: (e as Error).message })
      // Re-read — our in-memory copy may have raced another writer.
      void get().loadBoard()
      return false
    }
  },

  moveCardTo: async (ref, toColumn) => {
    const { board } = get()
    if (!board) return
    if (!moveCard(board, ref, toColumn)) return
    set({ board: { ...board } })
    await get().saveBoard()
  },

  addCardTo: async (column, text, agentKey) => {
    const { board } = get()
    if (!board) return
    if (!addCard(board, column, text, agentKey ? { agentKey } : undefined)) return
    set({ board: { ...board } })
    await get().saveBoard()
  },

  assignCard: async (ref, agentKey) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card) return
    card.agentKey = agentKey
    refreshCardLine(card)
    set({ board: { ...board } })
    await get().saveBoard()
  },

  toggleBlocked: async (ref) => {
    const { board } = get()
    if (!board) return
    const col = board.columns.find((c) => c.title === ref.column)
    const card = col?.cards[ref.index]
    if (!card) return
    card.blocked = !card.blocked
    refreshCardLine(card)
    set({ board: { ...board } })
    await get().saveBoard()
  },
}))

export { findCard }
