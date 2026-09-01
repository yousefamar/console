package io.amar.console.data.inbox

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.MailThreadRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_700_000_000_000L
private const val HOUR = 3_600_000L

private fun room(
    id: String = "!r1",
    name: String = "Alice",
    isDirect: Boolean = true,
    isUnread: Boolean = true,
    manualUnread: Boolean = false,
    muted: Boolean = false,
    lowPriority: Boolean = false,
    snoozedUntil: Long? = null,
    lastBody: String? = "hey",
    lastSender: String? = "Alice",
    lastTime: Long = NOW - HOUR,
    rawJson: String = "{}",
) = ChatRoomRow(
    id = id, name = name, avatarMxc = null, isDirect = isDirect, isUnread = isUnread,
    unreadCount = if (isUnread) 1 else 0, manualUnread = manualUnread,
    lastMessageBody = lastBody, lastMessageSender = lastSender, lastMessageTime = lastTime,
    lastReadEventId = null, isMuted = muted, isLowPriority = lowPriority, isEncrypted = false,
    memberCount = 2, networkIcon = "whatsapp", snoozedUntil = snoozedUntil, prevBatch = null,
    rawJson = rawJson,
)

private fun thread(
    id: String = "t1",
    fromEmail: String = "bob@example.com",
    isInbox: Boolean = true,
    snoozedUntil: Long? = null,
    date: Long = NOW - 2 * HOUR,
) = MailThreadRow(
    id = id, subject = "Subject", fromName = "Bob", fromEmail = fromEmail,
    snippet = "…", date = date, isUnread = true, isInbox = isInbox,
    hasAttachments = false, messageCount = 1, snoozedUntil = snoozedUntil, account = "a",
)

private fun feedItem(id: String = "i1", feedId: String = "f1", published: Long = NOW - HOUR) =
    FeedItemRow(id = id, feedId = feedId, title = "Post", link = null, content = null,
        snippet = null, publishedAt = published, imageUrl = null)

private fun feed(id: String = "f1", folder: String? = null) =
    FeedRow(id = id, title = "Feed", folder = folder)

private fun session(
    id: String = "s1",
    hasUnread: Boolean = true,
    attention: Boolean = false,
    isAl: Boolean = false,
    lastActivityAt: Long = NOW - 3 * HOUR,
) = AgentSessionRow(
    id = id, name = "Worker (fork)", status = "idle", hasUnread = hasUnread,
    needsAttention = attention, attentionSnippet = if (attention) "help" else null,
    agentKey = "worker", modelLabel = null, hibernated = false, cwd = null,
    lastCachedIndex = 0, messageLogLength = 5, isAl = isAl, lastActivityAt = lastActivityAt,
)

class InboxLogicTest {

    // ---- rules parse/serialize ----

    @Test
    fun `rules round-trip and tolerate partial json`() {
        assertEquals(InboxRules.DEFAULT, InboxRules.fromJson(null))
        assertEquals(InboxRules.DEFAULT, InboxRules.fromJson("not json"))
        assertEquals(InboxRules.DEFAULT, InboxRules.fromJson("{}"))
        val parsed = InboxRules.fromJson(
            """{"chat":{"default":"inbox","rooms":{"!r1":"feed"}},
                "feeds":{"feeds":{"f1":"hidden"}},"sla":{"dmHours":12,"rooms":{"!r2":0}}}""",
        )
        assertEquals("feed", parsed.routeForRoom("!r1"))
        assertEquals("inbox", parsed.routeForRoom("!other"))
        assertEquals("hidden", parsed.routeForFeed("f1"))
        assertEquals(12.0, parsed.slaDmHours, 0.0)
        assertEquals(0.0, parsed.slaRooms["!r2"]!!, 0.0)
        // Serialize → parse is identity.
        assertEquals(parsed, InboxRules.fromJson(parsed.toJson()))
    }

    // ---- membership ----

    @Test
    fun `membership mirrors source semantics`() {
        assertTrue(threadIsLive(thread(), NOW))
        assertFalse(threadIsLive(thread(isInbox = false), NOW))
        assertFalse(threadIsLive(thread(snoozedUntil = NOW + HOUR), NOW))
        assertTrue(threadIsLive(thread(snoozedUntil = NOW - 1), NOW))

        val r = InboxRules.DEFAULT
        assertTrue(roomIsLive(room(), r, NOW))
        assertTrue(roomIsLive(room(isUnread = false, manualUnread = true), r, NOW))
        assertFalse(roomIsLive(room(muted = true), r, NOW))
        assertFalse(roomIsLive(room(lowPriority = true), r, NOW))
        assertFalse(roomIsLive(room(snoozedUntil = NOW + HOUR), r, NOW))
        assertFalse(roomIsLive(room(isUnread = false), r, NOW))

        assertTrue(sessionIsLive(session()))
        assertFalse(sessionIsLive(session(hasUnread = false)))
        assertTrue(sessionIsLive(session(hasUnread = false, attention = true)))
        assertFalse(sessionIsLive(session(isAl = true)))
    }

    // ---- SLA ----

    @Test
    fun `overdue DM re-enters inbox despite being read`() {
        val raw = """{"lastInboundTs":${NOW - 30 * HOUR},"lastOutboundTs":${NOW - 40 * HOUR}}"""
        val overdueRoom = room(isUnread = false, rawJson = raw)
        assertTrue(isOverdue(overdueRoom, InboxRules.DEFAULT, NOW))
        assertTrue(roomIsLive(overdueRoom, InboxRules.DEFAULT, NOW))
        // Replying clears it.
        val replied = room(isUnread = false,
            rawJson = """{"lastInboundTs":${NOW - 30 * HOUR},"lastOutboundTs":${NOW - HOUR}}""")
        assertFalse(isOverdue(replied, InboxRules.DEFAULT, NOW))
        // Inside the window → not overdue.
        val fresh = room(isUnread = false,
            rawJson = """{"lastInboundTs":${NOW - 2 * HOUR},"lastOutboundTs":0}""")
        assertFalse(isOverdue(fresh, InboxRules.DEFAULT, NOW))
        // Groups have no default SLA.
        val group = room(isDirect = false, isUnread = false, rawJson = raw)
        assertFalse(isOverdue(group, InboxRules.DEFAULT, NOW))
        // Per-room override 0 disables even for DMs.
        val rules = InboxRules.DEFAULT.copy(slaRooms = mapOf("!r1" to 0.0))
        assertFalse(isOverdue(overdueRoom, rules, NOW))
    }

    // ---- adapters ----

    @Test
    fun `dm body drops sender prefix, groups keep it`() {
        val dm = roomToEntry(room(), InboxRules.DEFAULT, NOW)
        assertEquals("hey", dm.body)
        val group = roomToEntry(
            room(isDirect = false, name = "The Lads", lastSender = "Alice"),
            InboxRules.DEFAULT, NOW,
        )
        assertEquals("Alice: hey", group.body)
    }

    @Test
    fun `hidden-route feeds drop, hidden-folder feeds flag`() {
        val rules = InboxRules.DEFAULT.copy(feedFeeds = mapOf("f1" to "hidden"))
        assertNull(feedItemToEntry(feedItem(), feed(), rules))
        val x = feedItemToEntry(feedItem(), feed(folder = "X"), InboxRules.DEFAULT)!!
        assertTrue(x.hiddenFolder)
        assertFalse(feedItemToEntry(feedItem(), feed(folder = "news"), InboxRules.DEFAULT)!!.hiddenFolder)
    }

    // ---- ordering ----

    @Test
    fun `inbox bands order overdue, attention, chat+mail merged, agents, feeds`() {
        val rules = InboxRules.DEFAULT.copy(feedFeeds = mapOf("f1" to "inbox"))
        val overdue = roomToEntry(
            room(id = "!od", isUnread = false, lastTime = NOW - 50 * HOUR,
                rawJson = """{"lastInboundTs":${NOW - 30 * HOUR},"lastOutboundTs":0}"""),
            InboxRules.DEFAULT, NOW,
        )
        val attention = sessionToEntry(session(id = "sa", attention = true, lastActivityAt = NOW - 9 * HOUR))
        val chat = roomToEntry(room(id = "!c", lastTime = NOW - 5 * HOUR), InboxRules.DEFAULT, NOW)
        val mail = threadToEntry(thread(date = NOW - HOUR), InboxRules.DEFAULT)
        val agent = sessionToEntry(session(id = "sp", lastActivityAt = NOW))
        val feedEntry = feedItemToEntry(feedItem(), feed(), rules)!!
        val sorted = sortInbox(listOf(feedEntry, agent, chat, mail, attention, overdue))
        assertEquals(
            listOf("chat:!od", "agent:sa", "mail:t1", "chat:!c", "agent:sp", "feed:i1"),
            sorted.map { it.key },
        )
        // Fresh mail beats stale chat WITHIN the shared band (the merged-band rule).
        assertTrue(sorted.indexOfFirst { it.key == "mail:t1" } < sorted.indexOfFirst { it.key == "chat:!c" })
    }

    @Test
    fun `feed mode filters hidden-folder items`() {
        val normal = feedItemToEntry(feedItem(id = "a"), feed(), InboxRules.DEFAULT)!!
        val x = feedItemToEntry(feedItem(id = "b"), feed(folder = "x"), InboxRules.DEFAULT)!!
        assertEquals(listOf(normal), filterByFeedMode(listOf(normal, x), xOnly = false))
        assertEquals(listOf(x), filterByFeedMode(listOf(normal, x), xOnly = true))
    }

    // ---- composition ----

    @Test
    fun `composeInbox splits lists and respects read+snoozed sets`() {
        val lists = composeInbox(
            threads = listOf(thread()),
            rooms = listOf(room()),
            feedItems = listOf(feedItem(id = "a"), feedItem(id = "read"), feedItem(id = "snoozed")),
            feedsById = mapOf("f1" to feed()),
            readIds = setOf("read"),
            snoozedFeedIds = setOf("snoozed"),
            sessions = listOf(session()),
            rules = InboxRules.DEFAULT,
            now = NOW,
        )
        assertEquals(listOf("feed:a"), lists.feed.map { it.key })
        assertEquals(setOf("mail:t1", "chat:!r1", "agent:s1"), lists.inbox.map { it.key }.toSet())
    }

    // ---- promote/demote ----

    @Test
    fun `toggledRules writes overrides and removes default-matching ones`() {
        val chatEntry = roomToEntry(room(), InboxRules.DEFAULT, NOW)
        val demoted = toggledRules(InboxRules.DEFAULT, chatEntry)!!
        assertEquals("feed", demoted.routeForRoom("!r1"))
        // Toggling back lands on the default → override removed, not stored.
        val repromoted = toggledRules(demoted, chatEntry.copy(inInbox = false))!!
        assertTrue(repromoted.chatRooms.isEmpty())

        val feedEntry = feedItemToEntry(feedItem(), feed(), InboxRules.DEFAULT)!!
        val promoted = toggledRules(InboxRules.DEFAULT, feedEntry)!!
        assertEquals("inbox", promoted.routeForFeed("f1"))

        assertNull(toggledRules(InboxRules.DEFAULT, sessionToEntry(session())))
    }

    @Test
    fun `mail routes key on lowercased sender`() {
        val rules = InboxRules.DEFAULT.copy(mailSenders = mapOf("bob@example.com" to "feed"))
        val t = threadToEntry(thread(fromEmail = "Bob@Example.com"), rules)
        assertFalse(t.inInbox)
        assertEquals("bob@example.com", t.routeKey)
    }
}
