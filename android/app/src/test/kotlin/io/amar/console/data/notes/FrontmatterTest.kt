package io.amar.console.data.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrontmatterTest {

    @Test
    fun `parses title date project and scalar tags`() {
        val fm = FrontmatterParser.parse(
            """
            ---
            title: My Post
            date: 2026-07-20
            project: console
            tags: foo, bar
            ---
            body here
            """.trimIndent()
        )
        assertEquals("My Post", fm.title)
        assertEquals("2026-07-20", fm.date)
        assertEquals("console", fm.project)
        assertEquals(listOf("foo", "bar"), fm.tags)
    }

    @Test
    fun `parses inline array and block-list tags`() {
        assertEquals(
            listOf("a", "b"),
            FrontmatterParser.parse("---\ntags: [a, b]\n---\n").tags,
        )
        assertEquals(
            listOf("x", "y"),
            FrontmatterParser.parse("---\ntags:\n  - x\n  - y\n---\n").tags,
        )
    }

    @Test
    fun `no frontmatter yields empty`() {
        val fm = FrontmatterParser.parse("just a body\nno fences")
        assertNull(fm.title)
        assertTrue(fm.tags.isEmpty())
    }

    @Test
    fun `stamp replaces title in place preserving body`() {
        val out = FrontmatterParser.stamp("---\ntitle: Old\ndate: x\n---\nbody", listOf("title" to "New"))
        val fm = FrontmatterParser.parse(out)
        assertEquals("New", fm.title)
        assertEquals("x", fm.date)
        assertTrue(out.endsWith("body"))
    }

    @Test
    fun `stamp appends missing key`() {
        val out = FrontmatterParser.stamp("---\ntitle: T\n---\nbody", listOf("project" to "p"))
        assertEquals("p", FrontmatterParser.parse(out).project)
    }

    @Test
    fun `stamp tags as block list replacing scalar form`() {
        val out = FrontmatterParser.stamp("---\ntags: old\ntitle: T\n---\nbody", listOf("tags" to listOf("a", "b")))
        assertEquals(listOf("a", "b"), FrontmatterParser.parse(out).tags)
        assertEquals("T", FrontmatterParser.parse(out).title)
    }

    @Test
    fun `stamp creates frontmatter when absent`() {
        val out = FrontmatterParser.stamp("plain body", listOf("title" to "T"))
        assertTrue(out.startsWith("---\n"))
        assertEquals("T", FrontmatterParser.parse(out).title)
        assertTrue(out.endsWith("plain body"))
    }

    @Test
    fun `range covers the fenced block`() {
        val content = "---\ntitle: T\n---\nbody"
        val r = FrontmatterParser.range(content)!!
        assertEquals(0, r.first)
        assertEquals("---\ntitle: T\n---\n", content.substring(r.first, r.last + 1))
        assertNull(FrontmatterParser.range("no fm"))
    }

    @Test
    fun `permalink and path detection`() {
        assertEquals(
            "https://yousefamar.com/memo/log/2026-07-20-hello/",
            FrontmatterParser.permalinkForLogPath("log/2026-07-20-hello.md"),
        )
        assertEquals(
            "https://yousefamar.com/memo/log/2026-07-20-hello/",
            FrontmatterParser.permalinkForLogPath("projects/console/log/2026-07-20-hello.md"),
        )
        assertNull(FrontmatterParser.permalinkForLogPath("scratch/foo.md"))
        assertTrue(FrontmatterParser.isDraftPath("scratch/blog-drafts/idea.md"))
        assertTrue(FrontmatterParser.isPublishedPath("log/x.md"))
        assertTrue(FrontmatterParser.isPublishedPath("projects/console/log/x.md"))
        assertFalse(FrontmatterParser.isPublishedPath("projects/console/log/drafts/x.md"))
        assertFalse(FrontmatterParser.isPublishedPath("log/sub/x.md"))
        assertTrue(FrontmatterParser.isWritingFile("log/x.md"))
    }

    @Test
    fun `yamlScalar quotes what a plain scalar cannot hold`() {
        assertEquals("\"Foo: bar\"", FrontmatterParser.yamlScalar("Foo: bar"))
        assertEquals("\"Wait for it:\"", FrontmatterParser.yamlScalar("Wait for it:"))
        assertEquals("\"- dashed\"", FrontmatterParser.yamlScalar("- dashed"))
        assertEquals("\"#hash\"", FrontmatterParser.yamlScalar("#hash"))
        assertEquals("\"a #b\"", FrontmatterParser.yamlScalar("a #b"))
        assertEquals("\" padded \"", FrontmatterParser.yamlScalar(" padded "))
        assertEquals("\"\"", FrontmatterParser.yamlScalar(""))
        // Would come back as a non-string
        assertEquals("\"true\"", FrontmatterParser.yamlScalar("true"))
        assertEquals("\"2026\"", FrontmatterParser.yamlScalar("2026"))
        assertEquals("\"0x10\"", FrontmatterParser.yamlScalar("0x10"))
        assertEquals("\"~\"", FrontmatterParser.yamlScalar("~"))
        // Escapes
        assertEquals("\"He said \\\"hi\\\": ok\"", FrontmatterParser.yamlScalar("He said \"hi\": ok"))
        assertEquals("\"two: lines\\nhere\"", FrontmatterParser.yamlScalar("two: lines\nhere"))
        // Already safe — no churn
        assertEquals("plain title", FrontmatterParser.yamlScalar("plain title"))
        assertEquals("Sainsbury's CLI", FrontmatterParser.yamlScalar("Sainsbury's CLI"))
        assertEquals("2026-06-08 10:00:00", FrontmatterParser.yamlScalar("2026-06-08 10:00:00"))
        // Non-strings pass through
        assertEquals("true", FrontmatterParser.yamlScalar(true))
        assertEquals("7", FrontmatterParser.yamlScalar(7))
    }

    @Test
    fun `yamlScalar round-trips through unquote`() {
        val hostile = listOf(
            "Foo: bar", "Wait for it:", "plain", "Sainsbury's CLI",
            "He said \"hi\": really", "Bruteforcing tailnet \"fun names\"",
            "true", "2026", "back\\slash: x", "tab:\there", " padded ", "",
        )
        for (s in hostile) assertEquals(s, FrontmatterParser.unquote(FrontmatterParser.yamlScalar(s)))
    }

    @Test
    fun `unquote only strips a matched pair`() {
        assertEquals(
            "Bruteforcing tailnet \"fun names\"",
            FrontmatterParser.parse("---\ntitle: Bruteforcing tailnet \"fun names\"\n---\n").title,
        )
        assertEquals(
            "Blast: \"Cult II\" it's",
            FrontmatterParser.parse("---\ntitle: 'Blast: \"Cult II\" it''s'\n---\n").title,
        )
    }

    @Test
    fun `a quoted tags scalar is one tag`() {
        assertEquals(listOf("a, b"), FrontmatterParser.parse("---\ntags: \"a, b\"\n---\n").tags)
    }

    @Test
    fun `stamp escapes a title with a colon and tags with hazards`() {
        val out = FrontmatterParser.stamp(
            "---\ntitle: Old\n---\nbody",
            listOf("title" to "Foo: bar", "tags" to listOf("a: b", "plain")),
        )
        assertTrue(out.contains("title: \"Foo: bar\""))
        assertTrue(out.contains("  - \"a: b\""))
        val fm = FrontmatterParser.parse(out)
        assertEquals("Foo: bar", fm.title)
        assertEquals(listOf("a: b", "plain"), fm.tags)
    }

    @Test
    fun `project slug helpers`() {
        assertEquals("console", FrontmatterParser.projectSlugFromPath("projects/console.md"))
        assertEquals("console", FrontmatterParser.projectSlugFromPath("projects/console/index.md"))
        assertEquals("console", FrontmatterParser.enclosingProjectSlug("projects/console/devlog/1.md"))
        assertNull(FrontmatterParser.enclosingProjectSlug("scratch/x.md"))
    }
}
