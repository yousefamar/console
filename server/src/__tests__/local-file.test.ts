import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { resolveLocalMedia } from '../agents/local-file.js'

describe('resolveLocalMedia', () => {
  it('accepts absolute media paths and maps content types', () => {
    const r = resolveLocalMedia('/tmp/chart.png')
    expect(r).toEqual({ abs: '/tmp/chart.png', contentType: 'image/png' })
    expect(resolveLocalMedia('/tmp/clip.MP4')).toMatchObject({ contentType: 'video/mp4' })
  })

  it('expands ~/', () => {
    const r = resolveLocalMedia('~/shot.jpg')
    expect(r).toMatchObject({ abs: `${homedir()}/shot.jpg` })
  })

  it('normalizes traversal segments', () => {
    expect(resolveLocalMedia('/tmp/../etc/x.png')).toMatchObject({ abs: '/etc/x.png' })
  })

  it('rejects relative paths, empty, and non-media extensions', () => {
    expect(resolveLocalMedia('tmp/x.png')).toMatchObject({ status: 400 })
    expect(resolveLocalMedia('')).toMatchObject({ status: 400 })
    expect(resolveLocalMedia(null)).toMatchObject({ status: 400 })
    expect(resolveLocalMedia('/etc/passwd')).toMatchObject({ status: 415 })
    expect(resolveLocalMedia('/home/x/script.sh')).toMatchObject({ status: 415 })
  })
})
