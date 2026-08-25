// Wiki-link target minting — pure, unit-testable.
//
// Obsidian resolves a bare basename link ([[index]]) to ANY file with that
// name, so a vault with many index.md files makes the short form ambiguous
// (and the blog build picks the wrong one). Rule: use the basename when it's
// unique across the vault, else the full path (extension dropped either way).

export function wikiTarget(path: string, allPaths: string[]): string {
  const name = wikiDisplay(path)
  const dupes = allPaths.reduce((n, p) => (wikiDisplay(p) === name ? n + 1 : n), 0)
  return dupes > 1 ? path.replace(/\.md$/, '') : name
}

/** Human-readable default display text for a link to `path` (basename, no .md). */
export function wikiDisplay(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

/** Resolve a wiki-link target back to a vault path: exact path first (with or
 *  without .md), then basename match (first hit — legacy short links). */
export function resolveWikiTarget(target: string, allPaths: string[]): string | null {
  const exact = allPaths.find((p) => p === target || p === `${target}.md`)
  if (exact) return exact
  return allPaths.find((p) => wikiDisplay(p) === target) ?? null
}
