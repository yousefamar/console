import { describe, it, expect } from 'vitest'
import { isVideoPath } from '../components/AgentMessageBlock'

describe('isVideoPath', () => {
  it('matches known video extensions', () => {
    expect(isVideoPath('/tmp/a.mp4')).toBe(true)
    expect(isVideoPath('/tmp/a.webm')).toBe(true)
    expect(isVideoPath('/tmp/a.mov')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isVideoPath('/tmp/a.MP4')).toBe(true)
  })

  it('strips query/hash before checking the extension', () => {
    expect(isVideoPath('/tmp/a.mp4?t=1#frag')).toBe(true)
  })

  it('rejects non-video extensions', () => {
    expect(isVideoPath('/tmp/a.png')).toBe(false)
    expect(isVideoPath('/tmp/a.mp3')).toBe(false)
    expect(isVideoPath('/tmp/noext')).toBe(false)
  })
})
