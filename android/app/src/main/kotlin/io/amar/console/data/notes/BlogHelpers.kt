package io.amar.console.data.notes

/**
 * Pure helpers for the blog view — age formatting + age→severity mapping,
 * ports of src/components/notes/BlogView.tsx fmtAge + the draft age-colour
 * thresholds. Kept out of the composable so they can be unit-tested.
 */
object BlogHelpers {
    enum class AgeSeverity { FRESH, WARN, STALE } // tertiary / yellow / red

    /** ms-age → 'just now' / 'Nh ago' / 'Nd ago' / 'Nmo ago' / 'N.Ny ago'. */
    fun formatAge(ageMs: Long): String {
        val days = ageMs.toDouble() / 86_400_000.0
        if (days < 1) {
            val h = days * 24
            if (h < 1) return "just now"
            return "${Math.round(h)}h ago"
        }
        if (days < 30) return "${Math.round(days)}d ago"
        if (days < 365) return "${Math.round(days / 30)}mo ago"
        return "${"%.1f".format(days / 365)}y ago"
    }

    /** >30d → STALE (red), >7d → WARN (yellow), else FRESH. */
    fun ageSeverity(ageMs: Long): AgeSeverity {
        val days = ageMs.toDouble() / 86_400_000.0
        return when {
            days > 30 -> AgeSeverity.STALE
            days > 7 -> AgeSeverity.WARN
            else -> AgeSeverity.FRESH
        }
    }

    /** Post date shown as the first space-separated token, '(no date)' fallback. */
    fun postDateLabel(date: String?): String =
        date?.trim()?.split(' ')?.firstOrNull()?.ifBlank { null } ?: "(no date)"

    /** Humanise an untracked project slug → title-cased words. */
    fun humaniseSlug(slug: String): String = slug
        .replace(Regex("[-_]+"), " ")
        .trim()
        .split(' ')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } }

    /** Projects sorted active-first, then by most-recent post. */
    fun sortProjects(projects: List<BlogRepository.Project>): List<BlogRepository.Project> =
        projects.sortedWith(
            compareByDescending<BlogRepository.Project> { it.status == "active" }
                .thenByDescending { it.lastPostMtime ?: 0L }
        )
}
