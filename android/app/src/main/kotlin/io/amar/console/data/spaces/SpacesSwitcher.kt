package io.amar.console.data.spaces

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.db.areaList

/**
 * Pure half of the Spaces quick switcher — SPA src/components/
 * SpacesQuickSwitcher.tsx. Jump to ANYTHING: an area, a project, a live agent
 * session, or a vault file. Empty query = recency order (session activity /
 * file mtime / a space inherits its most recent member); a query fuzzy-ranks
 * with the SPA's scorer (contiguous substring beats any scattered
 * subsequence), recency breaking ties.
 */
object SpacesSwitcher {
    enum class Kind { AREA, PROJECT, SESSION, FILE }

    data class Entry(
        val key: String,
        val title: String,
        /** Secondary label: the owning space slug (sessions) or dir (files). */
        val hint: String?,
        val kind: Kind,
        val recency: Long,
        val isFork: Boolean = false,
        val running: Boolean = false,
        /** What to open: session id / file path / "kind/slug" for a space. */
        val target: String,
    )

    const val FILE_CAP = 2000
    const val RESULT_CAP = 40

    /** Project slug a vault path belongs to (`projects/<slug>/…` or `projects/<slug>.md`). */
    fun projectSlugOf(path: String): String? {
        val m = Regex("""^projects/([^/.]+)""").find(path) ?: return null
        return m.groupValues[1]
    }

    fun build(
        spaces: List<SpacesRepository.SpaceSummary>,
        sessions: List<AgentSessionRow>,
        files: List<NoteFileRow>,
        running: Set<String> = emptySet(),
    ): List<Entry> {
        val out = ArrayList<Entry>(spaces.size + sessions.size + minOf(files.size, FILE_CAP))
        val spaceRecency = HashMap<String, Long>()
        fun bump(slug: String?, ts: Long) {
            if (slug != null && ts > (spaceRecency[slug] ?: 0L)) spaceRecency[slug] = ts
        }
        for (s in sessions) {
            if (s.status == "ended") continue
            val slug = s.project ?: s.areaList().firstOrNull()
            val recency = maxOf(s.lastActivityAt, s.createdAt)
            bump(slug, recency)
            val name = s.name.ifBlank { s.id }
            out.add(Entry(
                key = "s:${s.id}",
                title = name.removeSuffix(" (fork)"),
                hint = slug,
                kind = Kind.SESSION,
                recency = recency,
                isFork = s.parentClaudeSessionId != null || name.endsWith(" (fork)"),
                running = s.id in running,
                target = s.id,
            ))
        }
        for (f in files.take(FILE_CAP)) {
            val slug = projectSlugOf(f.path)
            bump(slug, f.mtime)
            out.add(Entry(
                key = "f:${f.path}",
                title = f.name,
                hint = f.dir.ifBlank { null },
                kind = Kind.FILE,
                recency = f.mtime,
                target = f.path,
            ))
        }
        for (sp in spaces) {
            out.add(Entry(
                key = "sp:${sp.slug}",
                title = sp.title,
                hint = null,
                kind = if (sp.kind == "area") Kind.AREA else Kind.PROJECT,
                recency = spaceRecency[sp.slug] ?: 0L,
                target = "${sp.kind}/${sp.slug}",
            ))
        }
        return out
    }

    /**
     * SPA `fuzzyScore`: lower is better, -1 = no match. A contiguous substring
     * scores its index; a scattered subsequence scores 1000 + first hit, so
     * any substring match outranks any subsequence match.
     */
    fun fuzzyScore(text: String, q: String): Int {
        val idx = text.indexOf(q)
        if (idx >= 0) return idx
        var ti = 0
        var qi = 0
        var first = -1
        while (ti < text.length && qi < q.length) {
            if (text[ti] == q[qi]) {
                if (first < 0) first = ti
                qi++
            }
            ti++
        }
        return if (qi == q.length) 1000 + first else -1
    }

    fun rank(entries: List<Entry>, query: String): List<Entry> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return entries.sortedByDescending { it.recency }.take(RESULT_CAP)
        return entries
            .mapNotNull { e ->
                val score = fuzzyScore("${e.title} ${e.hint ?: ""}".lowercase(), q)
                if (score >= 0) e to score else null
            }
            .sortedWith(compareBy<Pair<Entry, Int>> { it.second }.thenByDescending { it.first.recency })
            .take(RESULT_CAP)
            .map { it.first }
    }
}
