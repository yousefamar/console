package io.amar.console.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The phone's half ([Changelog]) and the release half (`scripts/changelog.py`)
 * of "What's new", held together: the generator runs over the real BACKLOG.md
 * and its output must parse here with nothing dropped.
 */
class ChangelogTest {
    private fun v(code: Int, vararg items: String) = ChangelogVersion(code, "2026-10-0${code % 10}", items.toList())

    // ---- parse ---- //

    @Test fun `parses latest_json and a bare array alike, newest first`() {
        val array = """[{"versionCode":111,"date":"2026-10-08","items":["a"]},{"versionCode":112,"date":"2026-10-09","items":["b","c"]}]"""
        val expected = listOf(
            ChangelogVersion(112, "2026-10-09", listOf("b", "c")),
            ChangelogVersion(111, "2026-10-08", listOf("a")),
        )
        assertEquals(expected, Changelog.parse(array))
        assertEquals(expected, Changelog.parse("""{"versionCode":112,"url":"/apk/x.apk","changelog":$array}"""))
    }

    @Test fun `a latest_json from before the changelog existed is no notes, not an error`() {
        assertEquals(emptyList<ChangelogVersion>(), Changelog.parse("""{"versionCode":112,"url":"/apk/console-112.apk"}"""))
        assertEquals(emptyList<ChangelogVersion>(), Changelog.parse(null))
        assertEquals(emptyList<ChangelogVersion>(), Changelog.parse(""))
        assertEquals(emptyList<ChangelogVersion>(), Changelog.parse("<html>502 Bad Gateway</html>"))
    }

    @Test fun `malformed entries and versions without notes are dropped`() {
        val raw = """[
            {"versionCode":5,"date":"2026-01-05","items":["kept","  ",7,null]},
            {"versionCode":4,"date":"2026-01-04","items":[]},
            {"date":"2026-01-03","items":["no code"]},
            "nonsense",
            {"versionCode":5,"date":"dup","items":["duplicate code"]},
            {"versionCode":3,"items":["no date"]}
        ]"""
        assertEquals(
            listOf(ChangelogVersion(5, "2026-01-05", listOf("kept")), ChangelogVersion(3, "", listOf("no date"))),
            Changelog.parse(raw),
        )
    }

    @Test fun `encode round-trips, quotes and all`() {
        val versions = listOf(ChangelogVersion(112, "2026-10-09", listOf("sessions show \"not logged in\"", "Inbox|Feed · £ / %")))
        assertEquals(versions, Changelog.parse(Changelog.encode(versions)))
    }

    // ---- selection ---- //

    private val history = listOf(v(113, "c"), v(112, "b"), v(111, "a"), v(109, "z"))

    @Test fun `the banner lists every version between the installed one and the offer`() {
        assertEquals(listOf(113, 112), Changelog.between(history, 111, 113).map { it.versionCode })
        assertEquals(emptyList<ChangelogVersion>(), Changelog.between(history, 113, 113))
    }

    @Test fun `after an update, everything since the last version whose notes were shown`() {
        assertEquals(listOf(113, 112), Changelog.unseen(history, lastSeen = 111, installed = 113).map { it.versionCode })
        // Skipped over a version with no notes (110): still just what exists.
        assertEquals(listOf(111), Changelog.unseen(history, lastSeen = 109, installed = 111).map { it.versionCode })
    }

    @Test fun `nothing to show when the installed version was already seen`() {
        assertEquals(emptyList<ChangelogVersion>(), Changelog.unseen(history, lastSeen = 113, installed = 113))
        assertEquals(emptyList<ChangelogVersion>(), Changelog.unseen(history, lastSeen = 114, installed = 113))
    }

    @Test fun `never recorded means the installed version only, not the whole history`() {
        assertEquals(listOf(112), Changelog.unseen(history, lastSeen = 0, installed = 112).map { it.versionCode })
        // …and nothing at all when that version has no notes (a build newer than latest.json).
        assertEquals(emptyList<ChangelogVersion>(), Changelog.unseen(history, lastSeen = 0, installed = 114))
    }

    @Test fun `dates read day-first with a three-letter month`() {
        assertEquals("9 Oct 2026", Changelog.dateLabel("2026-10-09"))
        assertEquals("30 Sep 2026", Changelog.dateLabel("2026-09-30"))
        assertEquals("soon", Changelog.dateLabel("soon"))
    }

    // ---- the release-side generator ---- //

    private val androidDir: File by lazy {
        generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "scripts/changelog.py").exists() }
    }

    private fun generate(backlog: File, versionCode: Int, date: String = "2026-02-02"): Pair<Int, String> {
        val proc = ProcessBuilder(
            "python3", File(androidDir, "scripts/changelog.py").path,
            "--backlog", backlog.path, "--version-code", versionCode.toString(), "--date", date,
        ).redirectErrorStream(false).start()
        val out = proc.inputStream.bufferedReader().readText()
        return proc.waitFor() to out
    }

    private val hasPython: Boolean by lazy {
        runCatching { ProcessBuilder("python3", "--version").start().waitFor() == 0 }.getOrDefault(false)
    }

    private fun fixture(text: String): File = File.createTempFile("backlog", ".md").apply { writeText(text); deleteOnExit() }

    @Test fun `generator turns entry lead-ins into one line each`() {
        assumeTrue(hasPython)
        val backlog = fixture(
            """
            |# Backlog
            |
            |## Open (not yet built)
            |
            |- An open gap that has not shipped (^not-this)
            |
            |## Built, awaiting release
            |
            |- **A bold title that wraps onto
            |  a second line** (^soft-boar; Yousef, 9 Oct: "…"). Root cause follows
            |  over several lines.
            |  - a nested detail bullet
            |- Money: monthly spend chart (^jade-fox, closes the next item). Before, nothing.
            |- **Board grammar: `#effort/<level>` parsed (^odd-cat)**: more.
            |
            |## Shipped
            |
            |### v5 (2026-01-05)
            |
            |- Calendar sidebar's Delete now confirms first. It was the only one.
            |
            |### v4 (2026-01-04)
            |
            |- **Older thing**
            """.trimMargin(),
        )
        val (exit, out) = generate(backlog, versionCode = 6)
        assertEquals(0, exit)
        assertEquals(
            listOf(
                ChangelogVersion(
                    6, "2026-02-02",
                    listOf(
                        "A bold title that wraps onto a second line",
                        "Money: monthly spend chart",
                        "Board grammar: #effort/<level> parsed",
                    ),
                ),
                ChangelogVersion(5, "2026-01-05", listOf("Calendar sidebar's Delete now confirms first")),
                ChangelogVersion(4, "2026-01-04", listOf("Older thing")),
            ),
            Changelog.parse(out),
        )
    }

    @Test fun `generator refuses unreleased entries under an already shipped version`() {
        assumeTrue(hasPython)
        val backlog = fixture("## Built, awaiting release\n\n- **New**\n\n## Shipped\n\n### v5 (2026-01-05)\n\n- **Old**\n")
        assertNotEquals("a forgotten vCode bump must fail the release", 0, generate(backlog, versionCode = 5).first)
    }

    @Test fun `an empty awaiting-release block adds no version`() {
        assumeTrue(hasPython)
        val backlog = fixture("## Built, awaiting release\n\n_(nothing — v5 was cut 2026-01-05)_\n\n## Shipped\n\n### v5 (2026-01-05)\n\n- **Old**\n")
        val (exit, out) = generate(backlog, versionCode = 5)
        assertEquals(0, exit)
        assertEquals(listOf(5), Changelog.parse(out).map { it.versionCode })
    }

    @Test fun `the real BACKLOG yields clean notes for every recent version`() {
        assumeTrue(hasPython)
        // A code above anything shipped, so entries awaiting release are accepted whatever vCode says.
        val (exit, out) = generate(File(androidDir, "BACKLOG.md"), versionCode = 1_000_000)
        assertEquals(0, exit)
        val versions = Changelog.parse(out)
        assertEquals("every generated entry must survive the phone's parser", Regex("\"versionCode\"").findAll(out).count(), versions.size)
        assertTrue("expected a real history, got ${versions.size} version(s)", versions.size >= 10)
        assertEquals(versions.map { it.versionCode }.sortedDescending(), versions.map { it.versionCode })
        for (version in versions) for (item in version.items) {
            val where = "v${version.versionCode}: $item"
            assertTrue(where, item.length in 8..140)
            assertFalse(where, "**" in item || "`" in item || "(^" in item)
        }
    }
}
