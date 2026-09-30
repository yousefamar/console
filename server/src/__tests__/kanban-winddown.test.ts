// Silent wind-down decision: an approved ticket-fork whose worktree is clean
// and merged (or never existed) is folded in without waking it; anything
// dirty, unmerged or unrecognisable falls back to the wake.

import { describe, it, expect } from 'vitest'
import { parseWorktrees, worktreesForCard, probeSilentWindDown, summaryFromCardLines, type GitRunner } from '../kanban/winddown.js'

const PORCELAIN = `worktree /home/amar/proj/code/console
HEAD 81dc683b
branch refs/heads/main

worktree /home/amar/proj/code/console-worktrees/spry-bear-cost
HEAD 4356e701
branch refs/heads/spry-bear-cost

worktree /home/amar/proj/code/console-worktrees/odd-yak
HEAD deadbeef
detached
`

describe('parseWorktrees / worktreesForCard', () => {
  it('parses porcelain output, main tree first, detached heads without a branch', () => {
    const all = parseWorktrees(PORCELAIN)
    expect(all).toEqual([
      { path: '/home/amar/proj/code/console', branch: 'main', isMain: true },
      { path: '/home/amar/proj/code/console-worktrees/spry-bear-cost', branch: 'spry-bear-cost', isMain: false },
      { path: '/home/amar/proj/code/console-worktrees/odd-yak', branch: null, isMain: false },
    ])
  })
  it('matches a card by path or branch containing its block id, never the main tree', () => {
    const all = parseWorktrees(PORCELAIN)
    expect(worktreesForCard(all, 'spry-bear').map((w) => w.branch)).toEqual(['spry-bear-cost'])
    expect(worktreesForCard(all, 'odd-yak').map((w) => w.path)).toEqual(['/home/amar/proj/code/console-worktrees/odd-yak'])
    expect(worktreesForCard(all, 'main')).toEqual([])
    expect(worktreesForCard(all, 'lime-kiwi')).toEqual([])
  })
})

/** A scripted git: `answers` maps "<subcommand> …" prefixes to results. */
function scriptedGit(answers: Record<string, { stdout?: string; ok?: boolean }>, calls: string[] = []): GitRunner {
  return async (args) => {
    const key = args.join(' ')
    calls.push(key)
    for (const [prefix, r] of Object.entries(answers)) {
      if (key.startsWith(prefix)) return { stdout: r.stdout ?? '', ok: r.ok ?? true }
    }
    return { stdout: '', ok: false }
  }
}

const REPO = { 'rev-parse --show-toplevel': { stdout: '/repo\n' }, 'worktree list --porcelain': { stdout: PORCELAIN }, 'symbolic-ref -q --short refs/remotes/origin/HEAD': { stdout: 'origin/main\n' } }

describe('probeSilentWindDown', () => {
  it('is silent when no worktree carries the card id', async () => {
    const calls: string[] = []
    const r = await probeSilentWindDown('/tmp/nowhere-x', 'lime-kiwi', scriptedGit(REPO, calls))
    expect(r).toMatchObject({ silent: true, removed: [] })
    expect(calls.some((c) => c.startsWith('worktree remove'))).toBe(false)
  })

  it('removes a clean, merged worktree + branch and is silent', async () => {
    const calls: string[] = []
    const git = scriptedGit({ ...REPO, 'status --porcelain': { stdout: '' }, 'merge-base --is-ancestor spry-bear-cost main': { ok: true }, 'worktree remove': { ok: true }, 'branch -d': { ok: true } }, calls)
    const r = await probeSilentWindDown('/tmp/nowhere-x', 'spry-bear', git)
    expect(r).toMatchObject({ silent: true, removed: ['spry-bear-cost'] })
    expect(calls).toContain('worktree remove /home/amar/proj/code/console-worktrees/spry-bear-cost')
    expect(calls).toContain('branch -d spry-bear-cost')
  })

  it('needs the fork when the worktree is dirty', async () => {
    const calls: string[] = []
    const git = scriptedGit({ ...REPO, 'status --porcelain': { stdout: ' M server/src/x.ts\n' } }, calls)
    const r = await probeSilentWindDown('/tmp/nowhere-x', 'spry-bear', git)
    expect(r).toMatchObject({ silent: false })
    expect((r as { reason: string }).reason).toContain('uncommitted')
    expect(calls.some((c) => c.startsWith('worktree remove'))).toBe(false)
  })

  it('needs the fork when the branch is not merged into main', async () => {
    const git = scriptedGit({ ...REPO, 'status --porcelain': { stdout: '' }, 'merge-base --is-ancestor': { ok: false } })
    const r = await probeSilentWindDown('/tmp/nowhere-x', 'spry-bear', git)
    expect(r).toMatchObject({ silent: false })
    expect((r as { reason: string }).reason).toContain('not merged')
  })

  it('needs the fork when git refuses the removal', async () => {
    const git = scriptedGit({ ...REPO, 'status --porcelain': { stdout: '' }, 'merge-base --is-ancestor': { ok: true }, 'worktree remove': { ok: false } })
    const r = await probeSilentWindDown('/tmp/nowhere-x', 'spry-bear', git)
    expect(r).toMatchObject({ silent: false })
  })

  it('is silent when cwd is outside any repo', async () => {
    const r = await probeSilentWindDown('/tmp/nowhere-x', 'spry-bear', scriptedGit({}))
    expect(r).toMatchObject({ silent: true, removed: [] })
  })
})

describe('summaryFromCardLines', () => {
  it('uses the card\'s hand-back bullets as the digest', () => {
    const s = summaryFromCardLines('Fix the thing', ['- [ ] Fix the thing @k ^id', '  SCOPE: blah', '  - changed X', '  - verified Y'])
    expect(s).toContain('Card: Fix the thing')
    expect(s).toContain('- changed X\n- verified Y')
    expect(s).not.toContain('SCOPE')
  })
  it('says so when the card has no bullets', () => {
    expect(summaryFromCardLines('T', ['- [ ] T ^id'])).toContain('no hand-back bullets')
  })
})
