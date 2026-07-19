package io.amar.console.data.notes

/**
 * Pure helpers for the Notes quick switcher + create-note flow.
 * Fuzzy = case-insensitive subsequence match (SPA NotesQuickSwitcher parity,
 * minus the scoring — mobile shows mtime-sorted matches).
 */
object Fuzzy {
    /** True when every char of [query] appears in [target] in order. */
    fun matches(query: String, target: String): Boolean {
        if (query.isEmpty()) return true
        val q = query.lowercase()
        val t = target.lowercase()
        var qi = 0
        for (c in t) {
            if (c == q[qi]) {
                qi++
                if (qi == q.length) return true
            }
        }
        return false
    }

    /** Filter [items] whose [key] fuzzy-matches [query], preserving order. */
    fun <T> filter(items: List<T>, query: String, key: (T) -> String): List<T> =
        if (query.isBlank()) items else items.filter { matches(query.trim(), key(it)) }
}

/** "My Note: Draft!" → "my-note-draft" (filename-safe slug). */
fun slugify(title: String): String = title
    .lowercase()
    .replace(Regex("[^a-z0-9]+"), "-")
    .replace(Regex("-{2,}"), "-")
    .trim('-')
