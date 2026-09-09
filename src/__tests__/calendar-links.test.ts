// Client port of the private-link layout (mirror of server/src/calendar-links.ts —
// the two must agree on the key grammar) + link classification for the popover.

import { describe, it, expect } from 'vitest'
import { readLinks, classifyLink } from '@/calendar/links'

describe('readLinks (client port)', () => {
  it('reads console.link.<i> in key order and ignores the marker + foreign keys', () => {
    expect(readLinks({ extendedProperties: { private: { 'console.link.1': '/b', 'console.links': '1', 'console.link.0': '/a', other: 'x' } } })).toEqual(['/a', '/b'])
    expect(readLinks({})).toEqual([])
    expect(readLinks(undefined)).toEqual([])
  })
})

describe('classifyLink', () => {
  const root = '/home/amar/sync/brain/root'
  it('URLs open in a tab, labelled host+path', () => {
    expect(classifyLink('https://www.example.com/docs/x', root)).toEqual({ kind: 'url', label: 'example.com/docs/x', href: 'https://www.example.com/docs/x' })
  })
  it('absolute paths under the vault become vault-relative (open in Docs, peekable)', () => {
    expect(classifyLink(`${root}/projects/console/notes.md`, root)).toEqual({ kind: 'vault', label: 'notes.md', vaultPath: 'projects/console/notes.md' })
    // without a known root the same path is just a file
    expect(classifyLink(`${root}/projects/console/notes.md`, null).kind).toBe('file')
  })
  it('vault-relative .md shorthand is a vault note', () => {
    expect(classifyLink('projects/console/notes.md', null)).toEqual({ kind: 'vault', label: 'notes.md', vaultPath: 'projects/console/notes.md' })
  })
  it('bridge-servable media is media (images flagged), other files are files', () => {
    expect(classifyLink('/tmp/shot.PNG', root)).toEqual({ kind: 'media', label: 'shot.PNG', path: '/tmp/shot.PNG', image: true })
    expect(classifyLink('/tmp/deck.pdf', root)).toMatchObject({ kind: 'media', image: false })
    expect(classifyLink('/tmp/data.csv', root)).toEqual({ kind: 'file', label: 'data.csv', path: '/tmp/data.csv' })
  })
})
