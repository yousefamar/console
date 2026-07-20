package io.amar.console.data.mail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class MailFormatTest {

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long =
        Calendar.getInstance().apply {
            clear(); set(y, mo - 1, d, h, mi, 0)
        }.timeInMillis

    private fun cal(ts: Long) = Calendar.getInstance().apply { timeInMillis = ts }

    // ---------------------------------------------------------------- //
    // Snooze times

    @Test
    fun `laterToday is max of now+3h and 6pm`() {
        // Morning: 6pm wins.
        val morning = at(2026, 7, 20, 9, 0)
        val lt = MailFormat.laterToday(morning)
        assertEquals(18, cal(lt).get(Calendar.HOUR_OF_DAY))
        assertEquals(0, cal(lt).get(Calendar.MINUTE))

        // Evening: now+3h wins.
        val evening = at(2026, 7, 20, 20, 0)
        assertEquals(evening + 3 * 3600_000L, MailFormat.laterToday(evening))
    }

    @Test
    fun `tomorrow is next day 8am`() {
        val t = MailFormat.tomorrow(at(2026, 7, 20, 15, 30))
        val c = cal(t)
        assertEquals(21, c.get(Calendar.DAY_OF_MONTH))
        assertEquals(8, c.get(Calendar.HOUR_OF_DAY))
        assertEquals(0, c.get(Calendar.MINUTE))
    }

    @Test
    fun `nextWeek is next Monday 8am`() {
        // 2026-07-20 is a Monday. Next Monday = 2026-07-27.
        val mon = at(2026, 7, 20, 10, 0)
        assertEquals(Calendar.MONDAY, cal(mon).get(Calendar.DAY_OF_WEEK))
        val nw = cal(MailFormat.nextWeek(mon))
        assertEquals(Calendar.MONDAY, nw.get(Calendar.DAY_OF_WEEK))
        assertEquals(27, nw.get(Calendar.DAY_OF_MONTH))
        assertEquals(8, nw.get(Calendar.HOUR_OF_DAY))

        // From a Wednesday (2026-07-22) → Monday 2026-07-27.
        val wed = at(2026, 7, 22, 10, 0)
        val nw2 = cal(MailFormat.nextWeek(wed))
        assertEquals(Calendar.MONDAY, nw2.get(Calendar.DAY_OF_WEEK))
        assertEquals(27, nw2.get(Calendar.DAY_OF_MONTH))
    }

    // ---------------------------------------------------------------- //
    // File size

    @Test
    fun `formatFileSize scales B KB MB`() {
        assertEquals("512 B", MailFormat.formatFileSize(512))
        assertEquals("1.0 KB", MailFormat.formatFileSize(1024))
        assertEquals("1.5 KB", MailFormat.formatFileSize(1536))
        assertEquals("2.0 MB", MailFormat.formatFileSize(2L * 1024 * 1024))
    }

    // ---------------------------------------------------------------- //
    // Aliases + reply-all

    private val aliases = listOf(
        MailFormat.Alias("me@primary.com", "Me", isDefault = true),
        MailFormat.Alias("work@company.com", "Work"),
    )

    @Test
    fun `pickFromAddress prefers exact alias match in recipients`() {
        val from = MailFormat.pickFromAddress(aliases, "work@company.com, other@x.com", null, "me@primary.com")
        assertEquals("work@company.com", from)
    }

    @Test
    fun `pickFromAddress falls to same domain then default`() {
        // Domain match: recipient at company.com but not the alias address itself.
        assertEquals(
            "work@company.com",
            MailFormat.pickFromAddress(aliases, "someone@company.com", null, "me@primary.com"),
        )
        // No match → default alias.
        assertEquals(
            "me@primary.com",
            MailFormat.pickFromAddress(aliases, "stranger@nowhere.net", null, "me@primary.com"),
        )
    }

    @Test
    fun `replyAllCc drops own address and aliases`() {
        val cc = MailFormat.replyAllCc(
            toHeader = "Me <me@primary.com>, Alice <alice@x.com>",
            ccHeader = "Work <work@company.com>, Bob <bob@y.com>",
            fromEmail = "me@primary.com",
            aliasEmails = listOf("me@primary.com", "work@company.com"),
        )
        assertTrue(cc.contains("alice@x.com"))
        assertTrue(cc.contains("bob@y.com"))
        assertFalse(cc.contains("me@primary.com"))
        assertFalse(cc.contains("work@company.com"))
    }

    @Test
    fun `parseAddressEmails extracts bare emails`() {
        assertEquals(
            listOf("alice@x.com", "bob@y.com"),
            MailFormat.parseAddressEmails("\"Alice, A\" <alice@x.com>, bob@y.com"),
        )
    }

    // ---------------------------------------------------------------- //
    // Quoting + subject prefix

    @Test
    fun `rePrefix and fwdPrefix are idempotent case-insensitively`() {
        assertEquals("Re: Hi", MailFormat.rePrefix("Hi"))
        assertEquals("Re: Hi", MailFormat.rePrefix("Re: Hi"))
        assertEquals("RE: Hi", MailFormat.rePrefix("RE: Hi"))
        assertEquals("Fwd: Hi", MailFormat.fwdPrefix("Hi"))
        assertEquals("Fwd: Hi", MailFormat.fwdPrefix("Fwd: Hi"))
    }

    @Test
    fun `reply quote wraps original in blockquote`() {
        val q = MailFormat.replyQuote("Alice", "alice@x.com", at(2026, 1, 15, 9, 0), "<p>hi</p>")
        assertTrue(q.contains("gmail_quote"))
        assertTrue(q.contains("blockquote"))
        assertTrue(q.contains("alice@x.com"))
        assertTrue(q.contains("<p>hi</p>"))
    }

    @Test
    fun `forward quote has forwarded-message header`() {
        val q = MailFormat.forwardQuote("Alice", "alice@x.com", at(2026, 1, 15, 9, 0), "Subj", "me@x.com", "<p>body</p>")
        assertTrue(q.contains("Forwarded message"))
        assertTrue(q.contains("<b>Subject:</b> Subj"))
    }

    @Test
    fun `assembleSendHtml nests quote below user text`() {
        val html = MailFormat.assembleSendHtml("<p>reply</p>", "<div>quote</div>")
        assertEquals("<div dir=\"ltr\"><p>reply</p></div><div>quote</div>", html)
        assertEquals("<p>only</p>", MailFormat.assembleSendHtml("<p>only</p>", null))
    }

    // ---------------------------------------------------------------- //
    // Sanitize

    @Test
    fun `sanitizeHtml strips scripts iframes forms inputs`() {
        val dirty = "<p>ok</p><script>alert(1)</script><iframe src=x></iframe><form><input name=a></form>"
        val clean = MailFormat.sanitizeHtml(dirty)
        assertTrue(clean.contains("<p>ok</p>"))
        assertFalse(clean.contains("<script"))
        assertFalse(clean.contains("<iframe"))
        assertFalse(clean.contains("<form"))
        assertFalse(clean.contains("<input"))
    }
}
