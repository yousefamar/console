// ============================================================================
// Shared utility functions for the Agent Hub
// ============================================================================

/**
 * Native context window for a Claude model id in any shape (bare, `us.anthropic.`-
 * prefixed, date-versioned). Mirrors the CLI's baked-in catalog: Fable/Mythos,
 * Opus ≥ 4.7 and Sonnet ≥ 5 are 1M; Haiku and everything older is 200k.
 * Returns null for anything that isn't a recognisable Claude id (ARNs included).
 */
export function nativeContextWindow(model: string): number | null {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return null
  const family = m[1]!
  const major = parseInt(m[2]!, 10)
  const minor = m[3] ? parseInt(m[3], 10) : 0
  if (family === 'fable' || family === 'mythos') return 1_000_000
  if (family === 'opus') return major > 4 || (major === 4 && minor >= 7) ? 1_000_000 : 200_000
  if (family === 'sonnet') return major >= 5 ? 1_000_000 : 200_000
  return 200_000
}

/** Parse model string like "claude-opus-4-6[1m]" into display name and context window.
 *  A bracket hint wins; otherwise the window comes from the model family/version. */
export function parseModelString(model?: string): { displayName: string; contextWindow: number } {
  if (!model) return { displayName: 'unknown', contextWindow: 200_000 }

  let contextWindow: number | null = null
  let base = model

  // Extract bracket hint like [1m], [200k]
  const bracketMatch = model.match(/\[(\d+)([km])\]$/i)
  if (bracketMatch) {
    const num = parseInt(bracketMatch[1], 10)
    const unit = bracketMatch[2].toLowerCase()
    contextWindow = unit === 'm' ? num * 1_000_000 : num * 1_000
    base = model.slice(0, model.indexOf('['))
  }
  contextWindow ??= nativeContextWindow(base) ?? 200_000

  // Convert model ID to display name: "claude-opus-4-6" → "opus 4.6"
  let displayName = base
  const claudeMatch = base.match(/claude-(\w+)-(\d+)-(\d+)/)
  if (claudeMatch) {
    displayName = `${claudeMatch[1]} ${claudeMatch[2]}.${claudeMatch[3]}`
  } else {
    const simpleMatch = base.match(/claude-(\w+)-(\d+)/)
    if (simpleMatch) {
      displayName = `${simpleMatch[1]} ${simpleMatch[2]}`
    }
  }

  // Add context window hint to display name
  if (bracketMatch) {
    displayName += ` [${bracketMatch[1].toUpperCase()}${bracketMatch[2].toUpperCase()}]`
  }

  return { displayName, contextWindow }
}

/**
 * Encode a filesystem path to Claude's project directory name.
 * e.g. `/home/amar/proj/code/console` → `-home-amar-proj-code-console`
 */
export function cwdToProjectDir(cwdPath: string): string {
  // The CLI flattens every non-alphanumeric char to `-`, not just `/`:
  // observed `/tmp/reloc-a.gZkd` → `-tmp-reloc-a-gZkd` and
  // `~/.paperclip/…/.default` → `-home-amar--paperclip-…--default`. Mapping
  // only `/` made history lookups silently miss any cwd with a dot.
  return '-' + cwdPath.replace(/^\//, '').replace(/[^A-Za-z0-9-]/g, '-')
}
