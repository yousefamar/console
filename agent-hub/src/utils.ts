// ============================================================================
// Shared utility functions for the Agent Hub
// ============================================================================

/** Parse model string like "claude-opus-4-6[1m]" into display name and context window */
export function parseModelString(model?: string): { displayName: string; contextWindow: number } {
  if (!model) return { displayName: 'unknown', contextWindow: 200_000 }

  let contextWindow = 200_000
  let base = model

  // Extract bracket hint like [1m], [200k]
  const bracketMatch = model.match(/\[(\d+)([km])\]$/i)
  if (bracketMatch) {
    const num = parseInt(bracketMatch[1], 10)
    const unit = bracketMatch[2].toLowerCase()
    contextWindow = unit === 'm' ? num * 1_000_000 : num * 1_000
    base = model.slice(0, model.indexOf('['))
  }

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
  return '-' + cwdPath.replace(/^\//, '').replace(/\//g, '-')
}
