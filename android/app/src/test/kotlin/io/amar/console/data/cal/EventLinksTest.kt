package io.amar.console.data.cal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of src/__tests__/calendar-links.test.ts — the key grammar must match the hub's. */
class EventLinksTest {

    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test
    fun `readLinks orders by numeric index and skips junk keys`() {
        val e = obj(
            """{"id":"e","extendedProperties":{"private":{
                "console.link.2":"c","console.link.0":"a","console.link.10":"k","console.link.1":"b",
                "console.links":"1","console.link.x":"junk","console.link.-1":"neg","console.link.3":"","other":"z"}}}"""
        )
        assertEquals(listOf("a", "b", "c", "k"), readLinks(e))
    }

    @Test
    fun `readLinks is empty without extendedProperties or on garbage`() {
        assertEquals(emptyList<String>(), readLinks(obj("""{"id":"e"}""")))
        assertEquals(emptyList<String>(), readLinks("not json"))
        assertEquals(emptyList<String>(), readLinks(null))
    }

    @Test
    fun `withLinks lays the set out from 0, drops stale keys, keeps foreign keys and toggles the marker`() {
        val raw = """{"id":"e","summary":"s","extendedProperties":{"shared":{"x":"1"},"private":{
            "console.link.0":"old","console.link.1":"older","console.links":"1","mine":"kept"}}}"""
        val next = obj(withLinks(raw, listOf("new")))
        val priv = next["extendedProperties"]!!.jsonObject["private"]!!.jsonObject
        assertEquals("new", priv["console.link.0"]!!.jsonPrimitive.content)
        assertNull(priv["console.link.1"])
        assertEquals("1", priv["console.links"]!!.jsonPrimitive.content)
        assertEquals("kept", priv["mine"]!!.jsonPrimitive.content)
        assertEquals("1", next["extendedProperties"]!!.jsonObject["shared"]!!.jsonObject["x"]!!.jsonPrimitive.content)
        assertEquals("s", next["summary"]!!.jsonPrimitive.content)

        val cleared = obj(withLinks(raw, emptyList()))
        val clearedPriv = cleared["extendedProperties"]!!.jsonObject["private"]!!.jsonObject
        assertNull(clearedPriv["console.links"])
        assertNull(clearedPriv["console.link.0"])
        assertEquals("kept", clearedPriv["mine"]!!.jsonPrimitive.content)
    }

    @Test
    fun `withLinks round-trips through readLinks and parseEventDetails`() {
        val raw = withLinks("""{"id":"e"}""", listOf("projects/x/note.md", "https://a.b/c"))
        assertEquals(listOf("projects/x/note.md", "https://a.b/c"), readLinks(raw))
        assertEquals(listOf("projects/x/note.md", "https://a.b/c"), parseEventDetails(raw).links)
    }

    @Test
    fun `addLink dedupes and trims, removeLink drops by value`() {
        assertEquals(listOf("a"), addLink(emptyList(), "  a "))
        assertEquals(listOf("a"), addLink(listOf("a"), "a"))
        assertEquals(listOf("a"), addLink(listOf("a"), "   "))
        assertEquals(listOf("b"), removeLink(listOf("a", "b"), "a"))
    }

    @Test
    fun `classifyLink URL label is host plus path without www`() {
        val k = classifyLink("https://www.example.com/docs/x?q=1", null)
        assertTrue(k is LinkKind.Url)
        assertEquals("example.com/docs/x", k.label)
        assertEquals("https://www.example.com/docs/x?q=1", (k as LinkKind.Url).href)
        assertEquals("example.com", classifyLink("https://example.com/", null).label)
    }

    @Test
    fun `classifyLink resolves absolute vault paths only when the root is known`() {
        val abs = "/home/amar/sync/brain/root/projects/x/notes.md"
        val k = classifyLink(abs, "/home/amar/sync/brain/root/")
        assertTrue(k is LinkKind.Vault)
        assertEquals("projects/x/notes.md", (k as LinkKind.Vault).vaultPath)
        assertEquals("notes.md", k.label)
        // Without the root an absolute .md is just a file.
        assertTrue(classifyLink(abs, null) is LinkKind.File)
    }

    @Test
    fun `classifyLink vault-relative shorthand, media and plain files`() {
        assertTrue(classifyLink("projects/x/notes.md", null) is LinkKind.Vault)
        val img = classifyLink("/tmp/shot.PNG", null) as LinkKind.Media
        assertTrue(img.image)
        assertEquals("shot.PNG", img.label)
        val pdf = classifyLink("~/docs/a.pdf", null) as LinkKind.Media
        assertTrue(!pdf.image)
        assertTrue(classifyLink("/etc/hosts", null) is LinkKind.File)
        assertTrue(classifyLink("~/notes.md", null) is LinkKind.File)
    }

    @Test
    fun `mediaBridgeUrl encodes the path`() {
        assertEquals(
            "https://hub/agents/local-file?path=%2Ftmp%2Fa+b.png",
            mediaBridgeUrl("https://hub", "/tmp/a b.png"),
        )
    }
}
