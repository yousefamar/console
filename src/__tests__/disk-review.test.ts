import { describe, it, expect } from 'vitest'
import { decideReconcile } from '@/notes/disk-review'

// The pure half of disk reconciliation: given the open buffer (content +
// what it was last synced to), the text now on disk, and whether a live
// editor is showing the file, what happens.
describe('decideReconcile', () => {
  const clean = { content: 'A', savedContent: 'A' }
  const dirty = { content: 'A+typing', savedContent: 'A' }
  const shown = { force: false, onScreen: true }
  const hidden = { force: false, onScreen: false }

  it('disk equals the buffer → unchanged (re-arm only)', () => {
    expect(decideReconcile(clean, 'A', shown)).toBe('unchanged')
    expect(decideReconcile(clean, 'A', hidden)).toBe('unchanged')
    // Dirty buffer that now matches disk exactly (someone saved the same text).
    expect(decideReconcile(dirty, 'A+typing', shown)).toBe('unchanged')
  })

  it('disk still at our sync point while the user has unsaved edits → local-only, never a review', () => {
    // The classic self-save race: the poll announces OUR write while the user
    // has typed more. Nothing external happened.
    expect(decideReconcile(dirty, 'A', shown)).toBe('local-only')
    expect(decideReconcile(dirty, 'A', hidden)).toBe('local-only')
  })

  it('disk moved under the file on screen → review, clean or dirty', () => {
    expect(decideReconcile(clean, 'B', shown)).toBe('review')
    expect(decideReconcile(dirty, 'B', shown)).toBe('review')
  })

  it('disk moved under a clean buffer nobody is looking at → replace, no review', () => {
    expect(decideReconcile(clean, 'B', hidden)).toBe('replace')
  })

  it('disk moved under a dirty buffer off screen → still a review (the edits are the base)', () => {
    expect(decideReconcile(dirty, 'B', hidden)).toBe('review')
  })

  it('force (:e!) replaces whenever disk differs from the buffer, even with local edits', () => {
    expect(decideReconcile(dirty, 'A', { force: true, onScreen: true })).toBe('replace')
    expect(decideReconcile(clean, 'B', { force: true, onScreen: true })).toBe('replace')
    expect(decideReconcile(clean, 'A', { force: true, onScreen: true })).toBe('unchanged')
  })
})
