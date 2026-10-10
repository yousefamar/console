// cli/src/commands/util.ts parseFlags — the flag parser every `con` command shares.
import { describe, it, expect } from 'vitest'
import { parseFlags } from '../../cli/src/commands/util'

describe('con parseFlags', () => {
  it('reads --key value, --key=value and bare booleans', () => {
    expect(parseFlags(['card', '--to', 'Backlog', '--bottom', '--assign=al', '--n', '5']))
      .toEqual({ to: 'Backlog', bottom: 'true', assign: 'al', n: '5' })
    expect(parseFlags(['--undo', '--remove-last', '3'])).toEqual({ undo: 'true', 'remove-last': '3' })
    expect(parseFlags(['--since', '-7d'])).toEqual({ since: '-7d' })
  })

  it('keeps a value that merely starts with dashes', () => {
    // ^glad-pony, 10 Oct 2026: a note opening with a frontmatter fence was written as "true".
    const note = '---\ntitle: Sakib\n---\nbody'
    expect(parseFlags(['p.md', '--content', note])).toEqual({ content: note })
    expect(parseFlags(['room', '--body', '-- \nYousef'])).toEqual({ body: '-- \nYousef' })
    expect(parseFlags(['^id', '--note', '--force is needed here'])).toEqual({ note: '--force is needed here' })
    expect(parseFlags(['--detail', '--flag\nsecond line', '--bottom'])).toEqual({ detail: '--flag\nsecond line', bottom: 'true' })
  })

  it('a flag-shaped token is still a flag, and --key= carries one as a value', () => {
    expect(parseFlags(['--content', '--stdin'])).toEqual({ content: 'true', stdin: 'true' })
    expect(parseFlags(['--body=--force'])).toEqual({ body: '--force' })
    expect(parseFlags(['--data={"a":"--b"}'])).toEqual({ data: '{"a":"--b"}' })
  })

  it('dashed text in a positional slot is not a flag', () => {
    expect(parseFlags(['^id', '--- a note that starts with a rule'])).toEqual({})
  })
})
