package io.amar.console.data.notes

import io.amar.console.data.notes.BlogStale.Candidate
import io.amar.console.data.notes.BlogStale.SiteBuild
import io.amar.console.data.notes.BlogStale.SiteStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirror of src/__tests__/blog-stale.test.ts — keep the cases in sync. */
class BlogStaleTest {
    private val T = 1_000_000L

    private val files = listOf(
        Candidate("log/2026-09-01-10-00-00.md", T + 5_000),                     // stale, unhomed post
        Candidate("projects/demovid/log/2026-09-07-14-02-45.md", T + 60_000),   // stale, project post
        Candidate("log/2026-08-01-10-00-00.md", T - 1),                         // built after save → live
        Candidate("log/2026-08-02-10-00-00.md", T),                             // same instant → live (>= wins)
        Candidate("log/drafts/idea.md", T + 9_000),                             // draft, never a post
        Candidate("projects/demovid/log/drafts/wip.md", T + 9_000),             // project draft
        Candidate("projects/demovid/index.md", T + 9_000),                      // not a post
        Candidate("notes/foo.md", T + 9_000),
    )

    @Test
    fun `only published posts saved after the build, newest first`() {
        assertEquals(
            listOf("projects/demovid/log/2026-09-07-14-02-45.md", "log/2026-09-01-10-00-00.md"),
            BlogStale.stalePostCandidates(files, T).map { it.path },
        )
    }

    @Test
    fun `an unknown build time yields nothing rather than a false alarm`() {
        assertEquals(emptyList<Candidate>(), BlogStale.stalePostCandidates(files, null))
    }

    @Test
    fun `a build newer than every save clears the list`() {
        assertEquals(emptyList<Candidate>(), BlogStale.stalePostCandidates(files, T + 60_000))
    }

    // ---- buildClock -------------------------------------------------------

    private val started = "2026-10-05T19:38:04.522Z"
    private val startedMs = java.time.Instant.parse(started).toEpochMilli()

    @Test
    fun `reads the clock off the last successful build, at its START`() {
        val c = BlogStale.buildClock(
            SiteStatus(rebuilding = false, lastBuild = SiteBuild(ok = true, startedAt = started, finishedAt = "2026-10-05T19:38:39.176Z")),
            null,
        )
        assertEquals(BlogStale.BuildClock(startedMs, null, false), c)
    }

    @Test
    fun `keeps the previous clock and names the error when the last build FAILED`() {
        val err = "[11ty] Problem writing Eleventy templates: expected variable end"
        assertEquals(
            BlogStale.BuildClock(500L, err, false),
            BlogStale.buildClock(SiteStatus(lastBuild = SiteBuild(ok = false, startedAt = started, error = err)), 500L),
        )
    }

    @Test
    fun `a failed build with no error text still reports a failure`() {
        assertEquals(
            "The last site build failed",
            BlogStale.buildClock(SiteStatus(lastBuild = SiteBuild(ok = false, startedAt = started)), 500L).error,
        )
        assertEquals(
            "The last site build failed",
            BlogStale.buildClock(SiteStatus(lastBuild = SiteBuild(ok = false, error = "   ")), 500L).error,
        )
    }

    @Test
    fun `keeps the previous clock when the blog server has no build on record`() {
        assertEquals(
            BlogStale.BuildClock(500L, null, true),
            BlogStale.buildClock(SiteStatus(rebuilding = true, lastBuild = null), 500L),
        )
        assertEquals(BlogStale.BuildClock(500L, null, false), BlogStale.buildClock(null, 500L))
        // Nothing cached either → the repo falls back to a page probe.
        assertNull(BlogStale.buildClock(null, null).builtAt)
    }

    @Test
    fun `ignores an unparseable timestamp rather than blanking the clock`() {
        assertEquals(500L, BlogStale.buildClock(SiteStatus(lastBuild = SiteBuild(ok = true, startedAt = "not a date")), 500L).builtAt)
    }

    @Test
    fun `accepts an offset timestamp as well as a Z one`() {
        assertEquals(
            java.time.OffsetDateTime.parse("2026-10-05T20:38:04.522+01:00").toInstant().toEpochMilli(),
            BlogStale.buildClock(SiteStatus(lastBuild = SiteBuild(ok = true, startedAt = "2026-10-05T20:38:04.522+01:00")), null).builtAt,
        )
    }

    // ---- projectForPostPath ----------------------------------------------

    @Test
    fun `reads the slug from a project-homed post and nothing else`() {
        assertEquals("demovid", BlogStale.projectForPostPath("projects/demovid/log/2026-09-07-14-02-45.md"))
        assertNull(BlogStale.projectForPostPath("log/2026-09-07-14-02-45.md"))
        assertNull(BlogStale.projectForPostPath("projects/demovid/log/drafts/x.md"))
        assertNull(BlogStale.projectForPostPath("projects/demovid/index.md"))
    }
}
