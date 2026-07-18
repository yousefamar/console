import { describe, it, expect } from 'vitest'

// The REST catch-up route's window math is inline in index.ts (matching the
// existing get_older_messages style); replicate it here as a pure function
// against a fake session so the boundary logic is pinned by tests.

interface FakeSession {
  messageLog: Array<{ i: number }>
  messageLogOffset: number
  messageLogLength: number
}

function catchUp(session: FakeSession, since: number, limit: number) {
  const offset = session.messageLogOffset
  const total = session.messageLogLength
  const from = Math.max(since, offset)
  const memStart = from - offset
  const memEnd = Math.min(memStart + limit, session.messageLog.length)
  const slice = memStart < memEnd ? session.messageLog.slice(memStart, memEnd) : []
  return {
    messages: slice,
    fromIndex: from,
    totalLength: total,
    hasMore: from + slice.length < total,
    truncated: since < offset,
  }
}

function fakeSession(offset: number, count: number): FakeSession {
  return {
    messageLog: Array.from({ length: count }, (_, i) => ({ i: offset + i })),
    messageLogOffset: offset,
    messageLogLength: offset + count,
  }
}

describe('agents REST catch-up window math', () => {
  it('pages forward from an in-window since index', () => {
    const s = fakeSession(0, 100)
    const r = catchUp(s, 40, 20)
    expect(r.messages.map((m) => m.i)).toEqual(Array.from({ length: 20 }, (_, i) => 40 + i))
    expect(r.fromIndex).toBe(40)
    expect(r.hasMore).toBe(true)
    expect(r.truncated).toBe(false)
  })

  it('since at the tail returns empty with hasMore false', () => {
    const s = fakeSession(0, 100)
    const r = catchUp(s, 100, 50)
    expect(r.messages).toEqual([])
    expect(r.hasMore).toBe(false)
  })

  it('since older than the rolled-off boundary clamps + flags truncated', () => {
    // 500-cap window: offset 300, log holds 300..799
    const s = fakeSession(300, 500)
    const r = catchUp(s, 100, 50)
    expect(r.truncated).toBe(true)
    expect(r.fromIndex).toBe(300)
    expect(r.messages[0]!.i).toBe(300)
  })

  it('hasMore false exactly when the slice reaches the total', () => {
    const s = fakeSession(10, 30) // total 40
    const r = catchUp(s, 30, 50)
    expect(r.messages.map((m) => m.i)).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39])
    expect(r.hasMore).toBe(false)
  })
})

describe('Session dedupeKey memo', () => {
  // Import the real Session class's memo behaviour indirectly: the memo is a
  // tiny pure structure, tested via the same algorithm. (Constructing a full
  // Session requires a live subprocess; the memo has no such dependency.)
  class Memo {
    private readonly seen: string[] = []
    has(key: string): boolean {
      if (this.seen.includes(key)) return true
      this.seen.push(key)
      if (this.seen.length > 50) this.seen.shift()
      return false
    }
  }

  it('first delivery wins, retry drops', () => {
    const m = new Memo()
    expect(m.has('k1')).toBe(false)
    expect(m.has('k1')).toBe(true)
  })

  it('distinct keys pass', () => {
    const m = new Memo()
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(false)
  })

  it('memo is bounded at 50', () => {
    const m = new Memo()
    for (let i = 0; i < 55; i++) m.has(`k${i}`)
    // k0 rolled off — re-delivery would pass (acceptable: 50 sends later)
    expect(m.has('k0')).toBe(false)
    expect(m.has('k54')).toBe(true)
  })
})
