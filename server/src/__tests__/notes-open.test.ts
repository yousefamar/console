import { describe, it, expect } from 'vitest'
import { splitAnchor } from '../routes/notes.js'

describe('splitAnchor', () => {
  it('returns the bare path when there is no anchor', () => {
    expect(splitAnchor('projects/astera/index.md')).toEqual({ path: 'projects/astera/index.md' })
  })

  it('splits a trailing #Heading', () => {
    expect(splitAnchor('log/foo.md#Decisions')).toEqual({ path: 'log/foo.md', anchor: 'Decisions' })
  })

  it('keeps spaces in the anchor', () => {
    expect(splitAnchor('log/foo.md#Open questions')).toEqual({ path: 'log/foo.md', anchor: 'Open questions' })
  })

  it('splits on the LAST # so a # in the filename survives', () => {
    expect(splitAnchor('scratch/c#1.md#Notes')).toEqual({ path: 'scratch/c#1.md', anchor: 'Notes' })
  })

  it('treats a trailing bare # as no anchor', () => {
    expect(splitAnchor('log/foo.md#')).toEqual({ path: 'log/foo.md' })
    expect(splitAnchor('log/foo.md#   ')).toEqual({ path: 'log/foo.md' })
  })

  it('does not treat a leading # as an anchor separator', () => {
    expect(splitAnchor('#weird.md')).toEqual({ path: '#weird.md' })
  })
})
