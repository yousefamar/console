// Project directory discovery — finds Claude project dirs from ~/.claude/projects/

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
