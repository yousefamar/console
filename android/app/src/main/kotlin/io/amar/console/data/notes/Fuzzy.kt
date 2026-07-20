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

    /** A scored fuzzy match with the target-string indices that matched. */
    data class Scored<T>(val item: T, val score: Int, val positions: List<Int>)

    /**
     * Score a subsequence match (higher = better): consecutive runs and
     * word-boundary hits are rewarded, gaps penalised (fzf-lite). Returns null
     * when [query] isn't a subsequence of [target]. Positions index into
     * [target] (lowercased comparison, original indices).
     */
    fun score(query: String, target: String): Scored<Unit>? {
        if (query.isEmpty()) return Scored(Unit, 0, emptyList())
        val q = query.lowercase()
        val t = target.lowercase()
        var qi = 0
        var s = 0
        var prevMatch = -2
        val positions = ArrayList<Int>(q.length)
        for (ti in t.indices) {
            if (qi >= q.length) break
            if (t[ti] == q[qi]) {
                s += 1
                if (ti == prevMatch + 1) s += 3 // consecutive
                if (ti == 0 || !target[ti - 1].isLetterOrDigit()) s += 2 // word boundary
                prevMatch = ti
                positions.add(ti)
                qi++
            }
        }
        if (qi < q.length) return null
        // Reward matches nearer the start (basename bias handled by caller).
        s -= positions.first() / 4
        return Scored(Unit, s, positions)
    }

    /**
     * Rank [items] by fuzzy score against [key], best first, capped at [limit].
     * Empty query returns []. Ports src/notes/search-index.ts searchFilenames.
     */
    fun <T> rank(items: List<T>, query: String, limit: Int = 50, key: (T) -> String): List<Scored<T>> {
        if (query.isBlank()) return emptyList()
        val q = query.trim()
        return items.mapNotNull { item ->
            val sc = score(q, key(item)) ?: return@mapNotNull null
            Scored(item, sc.score, sc.positions)
        }.sortedByDescending { it.score }.take(limit)
    }
}

/** "My Note: Draft!" → "my-note-draft" (filename-safe slug). */
fun slugify(title: String): String = title
    .lowercase()
    .replace(Regex("[^a-z0-9]+"), "-")
    .replace(Regex("-{2,}"), "-")
    .trim('-')
