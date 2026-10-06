// A resume used to come back BARE — no name/agentKey/project/parent, and a cwd
// defaulted to the hub's own directory — so the board, which links a card to its
// fork by agentKey or name, showed every resumed ticket-fork as Unassigned and
// detached from its card (6 Oct 2026). The transcript is the last-resort source
// of identity when the manifest row is already gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTranscriptIdentity } from '../history.js'

let home: string
let realHome: string | undefined
const UUID = 'c277f50e-fa8b-4a2f-9418-9a33a0546586'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'transcript-identity-'))
  realHome = process.env.HOME
  // homedir() reads $HOME per call on linux, so no module reload is needed.
  process.env.HOME = home
  mkdirSync(join(home, '.claude', 'projects', '-home-amar-sync-brain-root-projects-astera'), { recursive: true })
})
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

const find = (csid: string) => findTranscriptIdentity(csid)

function writeTranscript(csid: string, lines: unknown[]) {
  writeFileSync(
    join(home, '.claude', 'projects', '-home-amar-sync-brain-root-projects-astera', `${csid}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n'),
  )
}

describe('findTranscriptIdentity', () => {
  it('reads the cwd off a message line, not from the lossy directory name', async () => {
    // The dir name maps both `a/b/c` and `a-b/c` to `a-b-c`, so decoding it is
    // ambiguous; the recorded cwd is exact.
    writeTranscript(UUID, [
      { type: 'custom-title', sessionId: UUID, customTitle: 'x' },
      { type: 'agent-name', sessionId: UUID, agentName: 'Glad wolf (fork)' },
      { type: 'user', sessionId: UUID, cwd: '/home/amar/sync/brain/root/projects/astera' },
    ])
    expect(find(UUID)).toEqual({ name: 'Glad wolf (fork)', cwd: '/home/amar/sync/brain/root/projects/astera' })
  })

  it('returns the name alone when no line carries a cwd', async () => {
    writeTranscript(UUID, [{ type: 'agent-name', sessionId: UUID, agentName: 'Blue tern (fork)' }])
    expect(find(UUID)).toEqual({ name: 'Blue tern (fork)' })
  })

  it('is null for an unknown csid, and survives a truncated or non-JSON head', async () => {
    expect(find('11111111-2222-3333-4444-555555555555')).toBeNull()
    writeFileSync(join(home, '.claude', 'projects', '-home-amar-sync-brain-root-projects-astera', `${UUID}.jsonl`), '{not json\n')
    expect(find(UUID)).toBeNull()
  })

  it('ignores a blank agentName and a blank cwd rather than reporting them', async () => {
    writeTranscript(UUID, [
      { type: 'agent-name', sessionId: UUID, agentName: '' },
      { type: 'user', sessionId: UUID, cwd: '' },
      { type: 'user', sessionId: UUID, cwd: '/real/cwd' },
    ])
    expect(find(UUID)).toEqual({ cwd: '/real/cwd' })
  })
})
