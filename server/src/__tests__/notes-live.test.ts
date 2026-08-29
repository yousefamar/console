import { describe, it, expect, afterEach } from 'vitest'
import { getLiveBuffer, setLiveBuffer } from '../routes/notes.js'

afterEach(() => setLiveBuffer(null))

describe('live buffer slot', () => {
  it('is empty by default', () => {
    expect(getLiveBuffer()).toBeNull()
  })

  it('round-trips a set buffer', () => {
    setLiveBuffer({ path: 'log/drafts/a.md', content: 'hello', cursorLine: 3, ts: 1000 })
    expect(getLiveBuffer(2000)).toMatchObject({ path: 'log/drafts/a.md', content: 'hello', cursorLine: 3 })
  })

  it('clears on null', () => {
    setLiveBuffer({ path: 'a.md', content: 'x', ts: 1000 })
    setLiveBuffer(null)
    expect(getLiveBuffer(2000)).toBeNull()
  })

  it('goes stale after 15 min of silence', () => {
    setLiveBuffer({ path: 'a.md', content: 'x', ts: 1000 })
    expect(getLiveBuffer(1000 + 15 * 60_000)).toMatchObject({ path: 'a.md' })
    expect(getLiveBuffer(1000 + 15 * 60_000 + 1)).toBeNull()
  })
})
