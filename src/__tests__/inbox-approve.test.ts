import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
})
vi.stubGlobal('document', { documentElement: { classList: { toggle: vi.fn() } } })
vi.mock('@/dialog', () => ({ showAlert: vi.fn(async () => {}) }))

import { approveHandbacks } from '@/inbox/approve'
import type { ReviewHandback } from '@/inbox/route'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { useSpacesStore } from '@/store/spaces'
import { useAgentStore } from '@/store/agent'
import { itemKey, type InboxItem } from '@/inbox/types'
import { showAlert } from '@/dialog'

const hb = (over: Partial<ReviewHandback> = {}): ReviewHandback =>
  ({ project: 'console', query: '^bold-fox', text: 'Bold fox card', doneColumn: 'Done', ...over })

describe('approveHandbacks', () => {
  it('moves every approvable card in order and skips boards with no Done column', async () => {
    const moves: string[] = []
    const out = await approveHandbacks(
      [hb(), hb({ project: 'astera', query: '^keen-vole', doneColumn: null }), hb({ query: '^tall-newt' })],
      async (p, q, to) => { moves.push(`${p} ${q} → ${to}`) },
    )
    expect(moves).toEqual(['console ^bold-fox → Done', 'console ^tall-newt → Done'])
    expect(out.moved.map((h) => h.query)).toEqual(['^bold-fox', '^tall-newt'])
    expect(out.skipped.map((h) => h.query)).toEqual(['^keen-vole'])
    expect(out.error).toBeUndefined()
  })

  it('stops at the first failing move and reports it', async () => {
    const moves: string[] = []
    const out = await approveHandbacks(
      [hb(), hb({ query: '^two' }), hb({ query: '^three' })],
      async (_p, q) => { if (q === '^two') throw new Error('{"error":"card not found"}'); moves.push(q) },
    )
    expect(moves).toEqual(['^bold-fox'])
    expect(out.moved).toHaveLength(1)
    expect(out.error?.handback.query).toBe('^two')
  })
})

describe('`e` on an agent Inbox row approves its Under Review cards', () => {
  const agentItem = (): InboxItem => ({
    key: itemKey('agent', 'session_9'), source: 'agent', sourceId: 'session_9', agentKey: 'console-general-bold-fox-fork',
    who: 'Bold fox', what: 'done', ts: 1, isUnread: true,
  } as unknown as InboxItem)

  beforeEach(() => {
    vi.mocked(showAlert).mockClear()
    useUnifiedInboxStore.setState({ inboxList: [agentItem()], selected: agentItem(), inboxFilter: null, snoozedList: [] })
    useSpacesStore.setState({
      spaces: [{ kind: 'project', slug: 'console', reviewCards: [{ blockId: 'bold-fox', text: 'Bold fox card', agentKey: 'console-general-bold-fox-fork' }], doneColumn: 'Done' }] as never,
    })
  })

  it('moves the card to Done and marks the session read sticky', async () => {
    const moves: string[] = []
    useSpacesStore.setState({ moveCardOnBoard: async (slug, q, to) => { moves.push(`${slug} ${q} → ${to}`) } })
    const read: unknown[] = []
    useAgentStore.setState({ markSessionRead: ((id: string, opts?: unknown) => { read.push([id, opts]) }) as never })

    useUnifiedInboxStore.getState().handleSelected('done')
    await new Promise((r) => setTimeout(r, 20))

    expect(moves).toEqual(['console ^bold-fox → Done'])
    expect(read).toEqual([['session_9', { sticky: true }]])
    expect(useUnifiedInboxStore.getState().inboxList.find((i) => i.key === itemKey('agent', 'session_9'))).toBeUndefined()
  })

  it('a board with no Done column just marks read, as before', async () => {
    useSpacesStore.setState({ spaces: [{ kind: 'project', slug: 'console', reviewCards: [{ blockId: 'bold-fox', text: 'x', agentKey: 'console-general-bold-fox-fork' }], doneColumn: null }] as never })
    const moves: string[] = []
    useSpacesStore.setState({ moveCardOnBoard: async (slug) => { moves.push(slug) } })
    const read: unknown[] = []
    useAgentStore.setState({ markSessionRead: ((id: string, opts?: unknown) => { read.push([id, opts]) }) as never })

    useUnifiedInboxStore.getState().handleSelected('done')
    await new Promise((r) => setTimeout(r, 20))

    expect(moves).toEqual([])
    // Nothing was approved, so the read is NOT sticky — the fork's next words should still surface.
    expect(read).toEqual([['session_9', undefined]])
  })

  it('a failed move alerts and does not mark the session read', async () => {
    useSpacesStore.setState({ moveCardOnBoard: async () => { throw new Error('{"error":"no such card"}') } })
    const read: unknown[] = []
    useAgentStore.setState({ markSessionRead: ((id: string) => { read.push(id) }) as never })

    useUnifiedInboxStore.getState().handleSelected('done')
    await new Promise((r) => setTimeout(r, 20))

    expect(read).toEqual([])
    expect(vi.mocked(showAlert)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(showAlert).mock.calls[0]![0]).toContain('no such card')
  })
})
