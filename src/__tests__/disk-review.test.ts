import { describe, it, expect } from 'vitest'
import { decideReconcile } from '@/notes/disk-review'

// The pure half of disk reconciliation: given the open buffer (content +
// what it was last synced to) and the text now on disk, what happens.
describe('decideReconcile', () => {
  const clean = { content: 'A', savedContent: 'A' }
  const dirty = { content: 'A+typing', savedContent: 'A' }

  it('disk equals the buffer → unchanged (re-arm only)', () => {
    expect(decideReconcile(clean, 'A', false)).toBe('unchanged')
    // Dirty buffer that now matches disk exactly (someone saved the same text).
    expect(decideReconcile(dirty, 'A+typing', false)).toBe('unchanged')
  })

  it('disk still at our sync point while the user has unsaved edits → local-only, never a review', () => {
    // The classic self-save race: the poll announces OUR write while the user
    // has typed more. Nothing external happened.
    expect(decideReconcile(dirty, 'A', false)).toBe('local-only')
  })

  it('disk moved past our sync point → review, clean or dirty', () => {
    expect(decideReconcile(clean, 'B', false)).toBe('review')
    expect(decideReconcile(dirty, 'B', false)).toBe('review')
  })

  it('force (:e!) replaces whenever disk differs from the buffer, even with local edits', () => {
    expect(decideReconcile(dirty, 'A', true)).toBe('replace')
    expect(decideReconcile(clean, 'B', true)).toBe('replace')
    expect(decideReconcile(clean, 'A', true)).toBe('unchanged')
  })
})
