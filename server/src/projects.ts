// Project directory discovery — finds Claude project dirs from ~/.claude/projects/

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Decode a Claude projects folder name back to a real filesystem path.
 * e.g. `-home-amar-proj-code-artanis-home-page` → `/home/amar/proj/code/artanis/home-page`
 *
 * Uses backtracking: at each segment boundary (hyphen), try inserting `/` first
 * and check if the prefix exists on disk. If not, treat the hyphen as literal.
 */
export function decodeClaudePath(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null
  const rest = encoded.slice(1)
  const parts = rest.split('-')
  if (parts.length === 0) return null

  function solve(index: number, currentPath: string): string | null {
    if (index >= parts.length) {
      return existsSync(currentPath) ? currentPath : null
    }

    const segment = parts[index]!

    const withSlash = currentPath + '/' + segment
    if (index < parts.length - 1) {
      if (existsSync(withSlash)) {
        const result = solve(index + 1, withSlash)
        if (result) return result
      }
    } else {
      const result = solve(index + 1, withSlash)
      if (result) return result
    }

    if (currentPath.length > 0) {
      const withHyphen = currentPath + '-' + segment
      const result = solve(index + 1, withHyphen)
      if (result) return result
    }

    if (index < parts.length - 1 && !existsSync(withSlash)) {
      const result = solve(index + 1, withSlash)
      if (result) return result
    }

    return null
  }

  return solve(0, '')
}

/**
 * Discover project directories from `~/.claude/projects/`.
 */
export function discoverProjectDirs(): string[] {
  const projectsDir = join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsDir)) return []

  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true })
    const dirs: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.includes('-worktrees-')) continue

      const decoded = decodeClaudePath(entry.name)
      if (decoded && existsSync(decoded)) {
        dirs.push(decoded)
      }
    }

    return dirs.sort()
  } catch {
    return []
  }
}

/**
 * Filesystem-level autocomplete for an absolute or `~`-relative path prefix.
 * Splits `q` into (parent dir, fragment). Lists `parent`'s subdirectories and
 * returns those starting with `fragment` (case-insensitive). Hides dotfiles
 * unless the fragment itself starts with `.`.
 */
export function listDirectories(q: string, limit = 50): string[] {
  if (!q) return []
  // Expand leading ~
  let expanded = q
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2))
  if (!expanded.startsWith('/')) return []  // Only absolute paths

  // If the input ends in `/`, list children of that exact dir; otherwise treat
  // the trailing segment as a fragment to filter parent's children by.
  const endsInSlash = expanded.endsWith('/')
  const parent = endsInSlash ? expanded.replace(/\/+$/, '') || '/' : dirname(expanded)
  const fragment = endsInSlash ? '' : expanded.slice(parent.length + (parent === '/' ? 0 : 1))

  if (!existsSync(parent)) return []
  try {
    const fragLower = fragment.toLowerCase()
    const showHidden = fragment.startsWith('.')
    const out: string[] = []
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (out.length >= limit) break
      if (!showHidden && entry.name.startsWith('.')) continue
      // Some entries (symlinks) need stat to confirm directory-ness
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = statSync(resolve(parent, entry.name)).isDirectory() } catch { isDir = false }
      }
      if (!isDir) continue
      if (fragment && !entry.name.toLowerCase().startsWith(fragLower)) continue
      out.push(parent === '/' ? '/' + entry.name : `${parent}/${entry.name}`)
    }
    return out.sort()
  } catch {
    return []
  }
}
