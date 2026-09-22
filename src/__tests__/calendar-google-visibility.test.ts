import { describe, it, expect } from 'vitest'
import { isShownInGoogle } from '@/calendar/google-visibility'

describe('isShownInGoogle', () => {
  it('shows only calendars Google marks selected', () => {
    expect(isShownInGoogle({ selected: true })).toBe(true)
    expect(isShownInGoogle({ selected: false })).toBe(false)
  })

  it('treats an OMITTED selected flag as unchecked (the sam@ leak)', () => {
    // Live shape 2026-09-22: sam@artanis.ai / olly@artanis.ai / Colours carry no
    // `selected` key at all — Google omits false.
    expect(isShownInGoogle({ accessRole: 'owner' } as { selected?: boolean })).toBe(false)
  })

  it('hidden or deleted entries never show', () => {
    expect(isShownInGoogle({ selected: true, hidden: true })).toBe(false)
    expect(isShownInGoogle({ selected: true, deleted: true })).toBe(false)
  })
})
