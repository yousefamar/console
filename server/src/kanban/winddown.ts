// Silent wind-down of an approved ticket-fork.
//
// When Yousef moves a card to Done the hub used to wake the fork twice: once
// with `[CARD APPROVED — wind down]` (merge/clean its worktree, say goodbye),
// once more to write its hand-back summary — and a fork that has been parked
// for days rewrites its whole 300–600k context to do so ($7 a wake, 92% of
// it the rewrite; $594/wk in the 2026-09-30 cost review §4). Most of those
// wakes had nothing left to do: the work was on main, the worktree clean or
// already gone, and the summary already sat on the card.
//
// This module decides whether a fork can be wound down WITHOUT waking it and
// does the fork's mechanical part (remove its clean, merged worktree + branch).
// The decision is conservative: any worktree that looks like this card's and
// is dirty, unmerged or un-removable → fall back to the wake. A worktree we
// cannot recognise as the card's is left alone (clutter, never data loss).
// Deploy-gated boards never take this path: there Done IS the merge signal.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'

const execFileP = promisify(execFile)

export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; ok: boolean }>

export const defaultGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
    return { stdout, ok: true }
  } catch (e) {
    return { stdout: String((e as { stdout?: string }).stdout ?? ''), ok: false }
  }
}

export interface Worktree { path: string; branch: string | null; isMain: boolean }

/** Parse `git worktree list --porcelain`. The first entry is the main tree. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  let cur: Partial<Worktree> | null = null
  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('worktree ')) {
      if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, isMain: out.length === 0 })
      cur = { path: line.slice('worktree '.length), branch: null }
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === '' && cur?.path) {
      out.push({ path: cur.path, branch: cur.branch ?? null, isMain: out.length === 0 })
      cur = null
    }
  }
  if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, isMain: out.length === 0 })
  return out
}

/** The worktrees that belong to this card: path basename or branch carries the
 *  card's block id (`autowt switch <ticket-slug>` slugs are card-derived by
 *  convention — `spry-bear-cost`, `lime-kiwi`). Never the main tree. */
export function worktreesForCard(all: Worktree[], blockId: string): Worktree[] {
  const id = blockId.toLowerCase()
  return all.filter((w) => !w.isMain && (basename(w.path).toLowerCase().includes(id) || (w.branch ?? '').toLowerCase().includes(id)))
}

/** The code repo a fork works in: `<cwd>/repo` (vault project dirs symlink
 *  their checkout) else the git toplevel of cwd itself. Null when cwd is not
 *  inside any repo. */
export async function repoRootFor(cwd: string, git: GitRunner = defaultGit): Promise<string | null> {
  const link = join(cwd, 'repo')
  if (existsSync(link)) {
    try { return realpathSync(link) } catch { /* dangling symlink → fall through */ }
  }
  const r = await git(['rev-parse', '--show-toplevel'], cwd)
  return r.ok ? r.stdout.trim() || null : null
}

export type WindDownProbe =
  | { silent: true; removed: string[]; reason: string }
  | { silent: false; reason: string }

/** Can this card's fork be wound down without a wake? Yes when every worktree
 *  recognisable as the card's is clean AND its branch is an ancestor of the
 *  repo's main branch — then the hub removes worktree + branch (both git
 *  commands refuse on their own if either check was wrong). No worktree at
 *  all is the common docs-only case and is silent too. */
export async function probeSilentWindDown(cwd: string, blockId: string, git: GitRunner = defaultGit): Promise<WindDownProbe> {
  const repo = await repoRootFor(cwd, git)
  if (!repo) return { silent: true, removed: [], reason: 'cwd is not in a git repo' }
  const list = await git(['worktree', 'list', '--porcelain'], repo)
  if (!list.ok) return { silent: false, reason: 'git worktree list failed' }
  const mine = worktreesForCard(parseWorktrees(list.stdout), blockId)
  if (mine.length === 0) return { silent: true, removed: [], reason: `no worktree named for ^${blockId} in ${repo}` }

  const main = await mainBranch(repo, git)
  if (!main) return { silent: false, reason: 'cannot determine the main branch' }

  for (const w of mine) {
    const status = await git(['status', '--porcelain'], w.path)
    if (!status.ok) return { silent: false, reason: `git status failed in ${w.path}` }
    if (status.stdout.trim()) return { silent: false, reason: `${basename(w.path)} has uncommitted changes` }
    if (w.branch && w.branch !== main) {
      const merged = await git(['merge-base', '--is-ancestor', w.branch, main], repo)
      if (!merged.ok) return { silent: false, reason: `branch ${w.branch} is not merged into ${main}` }
    }
  }
  const removed: string[] = []
  for (const w of mine) {
    const rm = await git(['worktree', 'remove', w.path], repo)
    if (!rm.ok) return { silent: false, reason: `git worktree remove ${basename(w.path)} refused` }
    removed.push(basename(w.path))
    if (w.branch && w.branch !== main) await git(['branch', '-d', w.branch], repo)
  }
  return { silent: true, removed, reason: `${removed.join(', ')} clean and merged into ${main}` }
}

async function mainBranch(repo: string, git: GitRunner): Promise<string | null> {
  const head = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], repo)
  if (head.ok && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '')
  for (const b of ['main', 'master']) {
    const r = await git(['rev-parse', '--verify', '-q', `refs/heads/${b}`], repo)
    if (r.ok) return b
  }
  return null
}

/** The fork's hand-back as the merge digest: the card's `- ` note lines, which
 *  are what Yousef approved. Falls back to the card title alone. */
export function summaryFromCardLines(text: string, lines: string[]): string {
  const notes = lines.slice(1).map((l) => l.trim()).filter((l) => l.startsWith('- '))
  return notes.length
    ? `Card: ${text}\n\nHand-back as approved on the card:\n${notes.join('\n')}`
    : `Card: ${text}\n\n(no hand-back bullets on the card)`
}
