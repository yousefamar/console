package io.amar.console.ui.mail

import io.amar.console.data.mail.MailFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MailPrefillTest {

    private val aliases = listOf(
        MailFormat.Alias("me@x.com", "Me", isDefault = true),
        MailFormat.Alias("work@company.com", "Work"),
    )

    private fun ctx() = ReplyContext(
        messageId = "m1",
        fromName = "Alice",
        fromEmail = "alice@ext.com",
        toHeader = "me@x.com, Bob <bob@ext.com>",
        ccHeader = "Carol <carol@ext.com>",
        subject = "Project",
        date = 1_700_000_000_000L,
        bodyHtml = "<p>hi</p>",
        bodyText = null,
    )

    @Test
    fun `reply targets sender and Re-prefixes subject with quote`() {
        val pf = prefill(ComposeMode.REPLY, ctx(), aliases, "me@x.com")
        assertEquals("Alice <alice@ext.com>", pf.to)
        assertEquals("Re: Project", pf.subject)
        assertTrue(pf.quotedHtml!!.contains("gmail_quote"))
        assertTrue(pf.quotedHtml!!.contains("<p>hi</p>"))
        // From picks the alias present in the original recipients.
        assertEquals("me@x.com", pf.from)
    }

    @Test
    fun `reply to my own message keeps original To`() {
        val mine = ctx().copy(fromEmail = "me@x.com")
        val pf = prefill(ComposeMode.REPLY, mine, aliases, "me@x.com")
        assertEquals("me@x.com, Bob <bob@ext.com>", pf.to)
    }

    @Test
    fun `reply-all Cc excludes my aliases and the sender stays in To`() {
        val pf = prefill(ComposeMode.REPLY_ALL, ctx(), aliases, "me@x.com")
        assertEquals("Alice <alice@ext.com>", pf.to)
        assertTrue(pf.cc.contains("bob@ext.com"))
        assertTrue(pf.cc.contains("carol@ext.com"))
        assertTrue(!pf.cc.contains("me@x.com"))
    }

    @Test
    fun `forward has Fwd subject, empty To, forwarded block`() {
        val pf = prefill(ComposeMode.FORWARD, ctx(), aliases, "me@x.com")
        assertEquals("", pf.to)
        assertEquals("Fwd: Project", pf.subject)
        assertTrue(pf.quotedHtml!!.contains("Forwarded message"))
    }

    @Test
    fun `compose is blank with default alias`() {
        val pf = prefill(ComposeMode.COMPOSE, null, aliases, "me@x.com")
        assertEquals("", pf.to)
        assertEquals("", pf.subject)
        assertEquals(null, pf.quotedHtml)
        assertEquals("me@x.com", pf.from)
    }

    @Test
    fun `replyContextFromMessage parses the from header`() {
        val rc = replyContextFromMessage("m1", "Alice <alice@ext.com>", "to@x.com", null, "S", 1L, "<p>b</p>", null)
        assertEquals("Alice", rc.fromName)
        assertEquals("alice@ext.com", rc.fromEmail)
    }
}
