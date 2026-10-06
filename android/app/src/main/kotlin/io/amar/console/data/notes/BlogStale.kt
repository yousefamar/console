package io.amar.console.data.notes

/**
 * The site's build clock + the stale-published-post set — Kotlin port of
 * `src/blog/stale.ts` (keep the two in sync).
 *
 * One number, the clock, decides staleness for every post at once: no per-post
 * HEAD, no extra hub state. The clock comes from the blog server's own
 * `/rebuild/status` (hub `GET /blog/site-status`), NOT from a page's
 * Last-Modified — Eleventy honours the vault's .gitignore, so a template can
 * drop out of the build while Caddy keeps serving its last-written file:
 * a `root/` directory glob landed in .gitignore on 3 Oct 2026 and froze /memo/ (the page the
 * phone used to probe) at 3 Oct 14:38, which marked everything published
 * afterwards stale forever.
 */
object BlogStale {
    /** A vault file considered for staleness — path + its real disk mtime. */
    data class Candidate(val path: String, val mtime: Long)

    data class SiteBuild(
        val ok: Boolean? = null,
        val startedAt: String? = null,
        val finishedAt: String? = null,
        /** `[11ty]` problem lines from a failed build. */
        val error: String? = null,
    )

    data class SiteStatus(
        val rebuilding: Boolean = false,
        /** null when the blog server has run no build since its last restart. */
        val lastBuild: SiteBuild? = null,
    )

    data class BuildClock(
        /** Files saved before this are reflected in the live site. */
        val builtAt: Long?,
        /** Why the site is frozen, when the last build failed. */
        val error: String?,
        val rebuilding: Boolean,
    )

    /**
     * Published posts whose file mtime is newer than the site's last build,
     * newest first. `siteBuiltAt == null` (site unreachable / not probed yet)
     * → none: we don't know, and a wrong "stale" is noisier than a missed one.
     */
    fun stalePostCandidates(files: List<Candidate>, siteBuiltAt: Long?): List<Candidate> {
        if (siteBuiltAt == null) return emptyList()
        return files
            .filter { FrontmatterParser.isPublishedPath(it.path) && it.mtime > siteBuiltAt }
            .sortedByDescending { it.mtime }
    }

    /**
     * Read the build clock off `/blog/site-status`.
     *
     * The boundary is the last SUCCESSFUL build's START: that is when Eleventy
     * read the vault, so a file saved after it is not in the output even though
     * the build finished later. A FAILED build leaves the site frozen at the
     * previous one — the clock keeps its old value and [BuildClock.error] says
     * why, so "stale" can name its cause instead of looking like a forgotten
     * publish.
     */
    fun buildClock(status: SiteStatus?, prevBuiltAt: Long?): BuildClock {
        val rebuilding = status?.rebuilding == true
        val last = status?.lastBuild ?: return BuildClock(prevBuiltAt, null, rebuilding)
        if (last.ok == false) {
            return BuildClock(prevBuiltAt, last.error?.trim()?.ifEmpty { null } ?: "The last site build failed", rebuilding)
        }
        val ms = last.startedAt?.let { parseIso(it) }
        return BuildClock(ms ?: prevBuiltAt, null, rebuilding)
    }

    /** Project slug implied by a project-homed post path, else null. */
    fun projectForPostPath(path: String): String? =
        Regex("^projects/([^/]+)/log/[^/]+\\.md$").find(path)?.groupValues?.get(1)

    /** ISO-8601 instant → epoch ms; null when unparseable (never blanks a clock). */
    private fun parseIso(s: String): Long? =
        runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrNull()
            ?: runCatching { java.time.OffsetDateTime.parse(s).toInstant().toEpochMilli() }.getOrNull()
}
