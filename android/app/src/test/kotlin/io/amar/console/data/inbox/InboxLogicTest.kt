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
    status: String = "idle",
    agentKey: String? = "worker",
) = AgentSessionRow(
    id = id, name = "Worker (fork)", status = status, hasUnread = hasUnread,
    needsAttention = attention, attentionSnippet = if (attention) "help" else null,
    agentKey = agentKey, modelLabel = null, hibernated = false, cwd = null,
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

        assertTrue(roomIsLive(room(), NOW))
        assertTrue(roomIsLive(room(isUnread = false, manualUnread = true), NOW))
        assertFalse(roomIsLive(room(muted = true), NOW))
        assertFalse(roomIsLive(room(lowPriority = true), NOW))
        assertFalse(roomIsLive(room(snoozedUntil = NOW + HOUR), NOW))
        assertFalse(roomIsLive(room(isUnread = false), NOW))

        assertTrue(sessionIsLive(session()))
        assertFalse(sessionIsLive(session(hasUnread = false)))
        assertTrue(sessionIsLive(session(hasUnread = false, attention = true)))
        assertFalse(sessionIsLive(session(isAl = true)))
    }

    // ---- SLA ----

    @Test
    fun `overdue is an escalation of UNREAD DMs only — a read thread is never overdue`() {
        val raw = """{"lastInboundTs":${NOW - 30 * HOUR},"lastOutboundTs":${NOW - 40 * HOUR}}"""
        val overdueRoom = room(rawJson = raw)
        assertTrue(isOverdue(overdueRoom, InboxRules.DEFAULT, NOW))
        assertTrue(roomToEntry(overdueRoom, InboxRules.DEFAULT, NOW).overdue)
        // Read = "seen, chose not to reply" (^neat-bass): not overdue, not live.
        val readRoom = room(isUnread = false, rawJson = raw)
        assertFalse(isOverdue(readRoom, InboxRules.DEFAULT, NOW))
        assertFalse(roomIsLive(readRoom, NOW))
        // Manual unread counts as unread.
        assertTrue(isOverdue(room(isUnread = false, manualUnread = true, rawJson = raw), InboxRules.DEFAULT, NOW))
        // Replying clears it.
        val replied = room(rawJson = """{"lastInboundTs":${NOW - 30 * HOUR},"lastOutboundTs":${NOW - HOUR}}""")
        assertFalse(isOverdue(replied, InboxRules.DEFAULT, NOW))
        // Inside the window → not overdue.
        val fresh = room(rawJson = """{"lastInboundTs":${NOW - 2 * HOUR},"lastOutboundTs":0}""")
        assertFalse(isOverdue(fresh, InboxRules.DEFAULT, NOW))
        // Groups have no default SLA.
        val group = room(isDirect = false, rawJson = raw)
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
            room(id = "!od", lastTime = NOW - 50 * HOUR,
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
    fun `session flags idle and review hand-back`() {
        val review = setOf("reviewer")
        val handback = sessionToEntry(session(agentKey = "reviewer"), review)
        assertTrue(handback.idle)
        assertTrue(handback.review)
        // Still running → not a hand-back yet even if its card sits in review.
        val running = sessionToEntry(session(status = "running", agentKey = "reviewer"), review)
        assertFalse(running.idle)
        assertFalse(running.review)
        // Idle but its key owns no review card → plain finished agent.
        val finished = sessionToEntry(session(agentKey = "other"), review)
        assertTrue(finished.idle)
        assertFalse(finished.review)
        // Null key / no review set → never a hand-back.
        assertFalse(sessionToEntry(session(agentKey = null), review).review)
        assertFalse(sessionToEntry(session(agentKey = "reviewer")).review)
    }

    @Test
    fun `agent tiers attention, review hand-back, chat+mail, finished, running`() {
        val review = setOf("reviewer")
        val running = sessionToEntry(session(id = "run", status = "running", lastActivityAt = NOW), review)
        val idle = sessionToEntry(session(id = "idle", lastActivityAt = NOW), review)
        val mail = threadToEntry(thread(date = NOW - HOUR), InboxRules.DEFAULT)
        val handback = sessionToEntry(session(id = "rev", agentKey = "reviewer", lastActivityAt = NOW - 9 * HOUR), review)
        val attention = sessionToEntry(session(id = "attn", attention = true, lastActivityAt = NOW - 9 * HOUR), review)
        val sorted = sortInbox(listOf(running, idle, mail, handback, attention))
        assertEquals(
            listOf("agent:attn", "agent:rev", "mail:t1", "agent:idle", "agent:run"),
            sorted.map { it.key },
        )
        // composeInbox threads reviewKeys through to the adapter.
        val lists = composeInbox(
            threads = emptyList(), rooms = emptyList(), feedItems = emptyList(), feedsById = emptyMap(),
            readIds = emptySet(), snoozedKeys = emptyMap(),
            sessions = listOf(session(id = "rev", agentKey = "reviewer"), session(id = "idle")),
            rules = InboxRules.DEFAULT, now = NOW, reviewKeys = review,
        )
        assertEquals(listOf("agent:rev", "agent:idle"), lists.inbox.map { it.key })
        assertTrue(lists.inbox[0].review)
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
            snoozedKeys = mapOf("feed:snoozed" to Long.MAX_VALUE),
            sessions = listOf(session()),
            rules = InboxRules.DEFAULT,
            now = NOW,
        )
        assertEquals(listOf("feed:a"), lists.feed.map { it.key })
        assertEquals(setOf("mail:t1", "chat:!r1", "agent:s1"), lists.inbox.map { it.key }.toSet())
        // The snoozed feed item is in the snoozed view with its due time, not gone.
        assertEquals(listOf("feed:snoozed"), lists.snoozed.map { it.key })
        assertEquals(Long.MAX_VALUE, lists.snoozed[0].snoozedUntil)
    }

    @Test
    fun `snoozed view collects every source soonest first and expiry is live`() {
        val lists = composeInbox(
            threads = listOf(thread(id = "late", snoozedUntil = NOW + 3 * HOUR), thread(id = "expired", snoozedUntil = NOW - HOUR)),
            rooms = listOf(room(id = "!soon", snoozedUntil = NOW + HOUR)),
            feedItems = listOf(feedItem(id = "f")),
            feedsById = mapOf("f1" to feed()),
            readIds = emptySet(),
            snoozedKeys = mapOf("feed:f" to NOW + 2 * HOUR, "agent:s1" to NOW + 30 * 60_000, "agent:gone" to NOW - 1),
            sessions = listOf(session(id = "s1"), session(id = "gone")),
            rules = InboxRules.DEFAULT,
            now = NOW,
        )
        assertEquals(listOf("agent:s1", "chat:!soon", "feed:f", "mail:late"), lists.snoozed.map { it.key })
        // Expired snoozes are live again (mail thread + agent), snoozed ones are not.
        assertEquals(setOf("mail:expired", "agent:gone"), lists.inbox.map { it.key }.toSet())
        assertTrue(lists.feed.isEmpty())
    }

    // ---- feed kinds ----

    @Test
    fun `feedKind classifies by host incl proxied url params`() {
        assertEquals(FeedKind.YOUTUBE, feedKind("https://www.youtube.com/feeds/videos.xml?channel_id=x", null))
        assertEquals(FeedKind.REDDIT, feedKind("https://old.reddit.com/r/kotlin/.rss", "https://reddit.com/r/kotlin"))
        assertEquals(FeedKind.HN, feedKind("https://hnrss.org/frontpage", null))
        assertEquals(FeedKind.SUBSTACK, feedKind(null, "https://someone.substack.com"))
        assertEquals(FeedKind.X, feedKind("https://granary.io/url?url=https%3A%2F%2Ftwitter.com%2Famar&input=html", null))
        assertEquals(FeedKind.X, feedKind("https://rsshub.app/twitter/user/amar", null))
        assertEquals(FeedKind.RSS, feedKind("https://example.com/feed.xml", "https://example.com"))
        assertEquals(FeedKind.RSS, feedKind(null as FeedRow?))
    }

    @Test
    fun `feed kind chips count in ORDER and filter narrows`() {
        val yt = feedItemToEntry(feedItem(id = "y"), FeedRow(id = "f1", title = "YT", folder = null, xmlUrl = "https://youtube.com/feeds/x"), InboxRules.DEFAULT)!!
        val rss = feedItemToEntry(feedItem(id = "r"), feed(), InboxRules.DEFAULT)!!
        val rss2 = feedItemToEntry(feedItem(id = "r2"), feed(), InboxRules.DEFAULT)!!
        assertEquals(listOf(FeedKind.YOUTUBE to 1, FeedKind.RSS to 2), feedKindsPresent(listOf(rss, yt, rss2)))
        assertEquals(listOf(yt), filterByFeedKind(listOf(rss, yt, rss2), FeedKind.YOUTUBE))
        assertEquals(3, filterByFeedKind(listOf(rss, yt, rss2), null).size)
    }

    // ---- review hand-backs ----

    @Test
    fun `reviewHandbacksFor joins an agent key to its review cards across project boards`() {
        val sp = io.amar.console.data.spaces.SpacesRepository.SpaceSummary(
            kind = "project", slug = "console", title = "Console", notePath = null, boardPath = "projects/console/board.md",
            status = null, fileCount = 0,
            reviewCards = listOf(
                io.amar.console.data.spaces.SpacesRepository.ReviewCard("abc", "Fix it", "worker"),
                io.amar.console.data.spaces.SpacesRepository.ReviewCard(null, "No id card", "worker"),
                io.amar.console.data.spaces.SpacesRepository.ReviewCard("zzz", "Other", "someone-else"),
            ),
            doneColumn = "Done",
        )
        val area = sp.copy(kind = "area", slug = "life", reviewCards = sp.reviewCards)
        val hb = reviewHandbacksFor("worker", listOf(sp, area))
        assertEquals(listOf("^abc", "No id card"), hb.map { it.query })
        assertEquals("Done", hb[0].doneColumn)
        assertTrue(reviewHandbacksFor(null, listOf(sp)).isEmpty())
        assertTrue(reviewHandbacksFor("nobody", listOf(sp)).isEmpty())
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
