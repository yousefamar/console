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
    isUnread: Boolean = true,
) = MailThreadRow(
    id = id, subject = "Subject", fromName = "Bob", fromEmail = fromEmail,
    snippet = "…", date = date, isUnread = isUnread, isInbox = isInbox,
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

private fun spaceSummary(
    slug: String = "console",
    title: String = "Console",
    reviewCards: List<io.amar.console.data.spaces.SpacesRepository.ReviewCard> = emptyList(),
    reviewAgentKeys: List<String> = reviewCards.mapNotNull { it.agentKey },
    blockedCards: List<io.amar.console.data.spaces.SpacesRepository.ReviewCard> = emptyList(),
    blockedAgentKeys: List<String> = blockedCards.mapNotNull { it.agentKey },
    ownedCards: List<io.amar.console.data.spaces.SpacesRepository.ReviewCard> = emptyList(),
    doneColumn: String? = "Done",
) = io.amar.console.data.spaces.SpacesRepository.SpaceSummary(
    kind = "project", slug = slug, title = title, notePath = null, boardPath = "projects/$slug/board.md",
    status = null, fileCount = 0, reviewCount = reviewCards.size, reviewAgentKeys = reviewAgentKeys,
    reviewCards = reviewCards, blockedCards = blockedCards, blockedAgentKeys = blockedAgentKeys,
    ownedCards = ownedCards, doneColumn = doneColumn,
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

        // A drafted room is live whatever its read/mute state, unless snoozed.
        val drafted = """{"draft":"reply for review","draftUpdatedAt":${NOW - 500}}"""
        assertTrue(roomIsLive(room(isUnread = false, rawJson = drafted), NOW))
        assertTrue(roomIsLive(room(isUnread = false, muted = true, rawJson = drafted), NOW))
        assertFalse(roomIsLive(room(isUnread = false, snoozedUntil = NOW + HOUR, rawJson = drafted), NOW))
        assertFalse(roomIsLive(room(isUnread = false, rawJson = """{"draft":"  "}"""), NOW))
        val entry = roomToEntry(room(isUnread = false, rawJson = drafted), InboxRules.DEFAULT, NOW)
        assertTrue(entry.draft)
        assertEquals("reply for review", entry.body)
        assertEquals(NOW - 500, entry.ts)

        assertTrue(sessionIsLive(session()))
        assertFalse(sessionIsLive(session(hasUnread = false)))
        assertTrue(sessionIsLive(session(hasUnread = false, attention = true)))
        assertFalse(sessionIsLive(session(isAl = true)))
        // A RUNNING session's unread text is a turn still being typed — not
        // inbox material (^neat-fawn) — unless it needs attention (a question
        // or approval blocks the turn, and that IS Yousef's to answer).
        assertFalse(sessionIsLive(session(status = "running")))
        assertTrue(sessionIsLive(session(status = "running", attention = true)))
        assertTrue(sessionIsLive(session(status = "running", hasUnread = false, attention = true)))
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

    // Port of the ^fond-koi cases in src/__tests__/inbox-route.test.ts.
    @Test
    fun `mail carries read state - an opened-but-unarchived thread is unread=false`() {
        assertEquals(true, threadToEntry(thread(isUnread = true), InboxRules.DEFAULT).unread)
        assertEquals(false, threadToEntry(thread(isUnread = false), InboxRules.DEFAULT).unread)
    }

    @Test
    fun `chat carries read state - manual-unread counts, a read room kept live by a draft is unread=false`() {
        assertEquals(true, roomToEntry(room(isUnread = false, manualUnread = true), InboxRules.DEFAULT, NOW).unread)
        val drafted = room(isUnread = false, rawJson = """{"draft":"reply…"}""")
        assertEquals(false, roomToEntry(drafted, InboxRules.DEFAULT, NOW).unread)
    }

    @Test
    fun `feeds carry no read state - rows drop the moment they are read`() {
        assertNull(feedItemToEntry(feedItem(), feed(), InboxRules.DEFAULT)!!.unread)
    }

    @Test
    fun `agents - unread or asking = unread=true, so a live agent never reads as seen`() {
        assertEquals(true, sessionToEntry(session(hasUnread = true)).unread)
        assertEquals(true, sessionToEntry(session(hasUnread = false, attention = true)).unread)
        assertEquals(false, sessionToEntry(session(hasUnread = false)).unread)
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
    fun `agent tiers attention or blocked, review hand-back, chat+mail, finished`() {
        val review = setOf("reviewer")
        val blockedKeys = setOf("stuck")
        val idle = sessionToEntry(session(id = "idle", lastActivityAt = NOW), review)
        val mail = threadToEntry(thread(date = NOW - HOUR), InboxRules.DEFAULT)
        val handback = sessionToEntry(session(id = "rev", agentKey = "reviewer", lastActivityAt = NOW - 9 * HOUR), review)
        val attention = sessionToEntry(session(id = "attn", attention = true, lastActivityAt = NOW - 9 * HOUR), review)
        // A #blocked card bands with attention (^mild-ibis) — older than attention here, so after it.
        val blocked = sessionToEntry(session(id = "blk", agentKey = "stuck", lastActivityAt = NOW - 10 * HOUR), review, blockedKeys = blockedKeys)
        assertTrue(blocked.blocked)
        val sorted = sortInbox(listOf(idle, mail, handback, attention, blocked))
        assertEquals(
            listOf("agent:attn", "agent:blk", "agent:rev", "mail:t1", "agent:idle"),
            sorted.map { it.key },
        )
        // composeInbox derives review/blocked keys, titles and card text from the spaces list.
        val sp = spaceSummary(
            reviewCards = listOf(io.amar.console.data.spaces.SpacesRepository.ReviewCard("abc", "Ship the fix", "reviewer")),
            reviewAgentKeys = listOf("reviewer"),
            blockedCards = listOf(io.amar.console.data.spaces.SpacesRepository.ReviewCard("zzz", "Need creds", "stuck")),
            blockedAgentKeys = listOf("stuck"),
        )
        val lists = composeInbox(
            threads = emptyList(), rooms = emptyList(), feedItems = emptyList(), feedsById = emptyMap(),
            readIds = emptySet(), snoozedKeys = emptyMap(),
            sessions = listOf(
                session(id = "rev", agentKey = "reviewer").copy(project = "console"),
                session(id = "idle", agentKey = "nobody"),
                // Running + unread is NOT admitted, blocked card or not; running + attention is.
                session(id = "run", status = "running", lastActivityAt = NOW),
                session(id = "runblk", status = "running", agentKey = "stuck"),
                session(id = "runattn", status = "running", attention = true, lastActivityAt = NOW - 20 * HOUR),
            ),
            rules = InboxRules.DEFAULT, now = NOW, spaces = listOf(sp),
        )
        assertEquals(listOf("agent:runattn", "agent:rev", "agent:idle"), lists.inbox.map { it.key })
        val rev = lists.inbox[1]
        assertTrue(rev.review)
        // Card-owned rows are titled with the CARD, name → agentName; space title is the context.
        assertEquals("Ship the fix", rev.header)
        assertEquals("Worker", rev.agentName)
        assertEquals("Console", rev.context)
        // Uncarded sessions keep their name and no agentName.
        assertEquals("Worker", lists.inbox[2].header)
        assertNull(lists.inbox[2].agentName)
    }

    @Test
    fun `sessionContext prefers the project title, else the first area, else nothing`() {
        val titles = mapOf("console" to "Console", "life" to "Life")
        assertEquals("Console", sessionContext("console", "life,health") { titles[it] })
        assertEquals("Life", sessionContext(null, "life,health") { titles[it] })
        assertEquals("unknown-slug", sessionContext("unknown-slug", null) { titles[it] })
        assertNull(sessionContext(null, null) { titles[it] })
        assertNull(sessionContext(null, "") { titles[it] })
        val e = sessionToEntry(session(id = "s").copy(project = "console"), titleOf = { titles[it] })
        assertEquals("Console", e.context)
        assertNull(sessionToEntry(session(id = "s")).context)
    }

    @Test
    fun `blockedCardsFor blockedAgentKeys and ownedCardText join board state across projects`() {
        val console = spaceSummary(
            slug = "console", title = "Console",
            reviewCards = listOf(io.amar.console.data.spaces.SpacesRepository.ReviewCard("rev", "Reviewed card", "worker")),
            blockedCards = listOf(io.amar.console.data.spaces.SpacesRepository.ReviewCard("blk", "Blocked card", "worker"), io.amar.console.data.spaces.SpacesRepository.ReviewCard(null, "Someone else", "other")),
            blockedAgentKeys = listOf("worker", "other"),
            ownedCards = listOf(io.amar.console.data.spaces.SpacesRepository.ReviewCard("own", "In-progress card", "worker"), io.amar.console.data.spaces.SpacesRepository.ReviewCard("o2", "Third card", "third")),
        )
        val area = console.copy(kind = "area", slug = "life")
        val spaces = listOf(console, area)
        assertEquals(listOf(BlockedCard("console", "^blk", "Blocked card")), blockedCardsFor("worker", spaces))
        assertEquals(listOf(BlockedCard("console", "Someone else", "Someone else")), blockedCardsFor("other", spaces))
        assertTrue(blockedCardsFor(null, spaces).isEmpty())
        assertEquals(setOf("worker", "other"), blockedAgentKeys(spaces))
        // blocked → review → in-progress preference.
        assertEquals("Blocked card", ownedCardText("worker", spaces))
        assertEquals("Reviewed card", ownedCardText("worker", listOf(console.copy(blockedCards = emptyList()))))
        assertEquals("In-progress card", ownedCardText("worker", listOf(console.copy(blockedCards = emptyList(), reviewCards = emptyList()))))
        assertEquals("Third card", ownedCardText("third", spaces))
        assertNull(ownedCardText("nobody", spaces))
        assertNull(ownedCardText(null, spaces))
    }

    @Test
    fun `feed rows lead with the article title and carry the feed name beneath`() {
        val e = feedItemToEntry(feedItem(), feed(), InboxRules.DEFAULT)!!
        assertEquals("Post", e.header)
        assertEquals("Feed", e.body)
        assertEquals("", feedItemToEntry(feedItem(), null, InboxRules.DEFAULT)!!.body)
    }

    @Test
    fun `approveHandbacks moves in order, skips boards with no Done column, stops at the first failure`() = kotlinx.coroutines.runBlocking {
        val a = io.amar.console.data.spaces.SpacesRepository.ReviewHandback("console", "^a", "A", "Done")
        val noDone = io.amar.console.data.spaces.SpacesRepository.ReviewHandback("home", "^n", "N", null)
        val b = io.amar.console.data.spaces.SpacesRepository.ReviewHandback("console", "^b", "B", "Done")
        val c = io.amar.console.data.spaces.SpacesRepository.ReviewHandback("console", "^c", "C", "Done")
        val moves = ArrayList<String>()
        val ok = approveHandbacks(listOf(a, noDone, b)) { p, q, col -> moves += "$p:$q→$col"; true }
        assertEquals(listOf("console:^a→Done", "console:^b→Done"), moves)
        assertEquals(listOf(a, b), ok.moved)
        assertEquals(listOf(noDone), ok.skipped)
        assertNull(ok.failed)
        moves.clear()
        val bad = approveHandbacks(listOf(a, b, c)) { _, q, _ -> moves += q; q != "^b" }
        assertEquals(listOf("^a", "^b"), moves) // c never attempted
        assertEquals(listOf(a), bad.moved)
        assertEquals(b, bad.failed)
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
    fun `listOverrides labels from local tables, groups chat then mail then feeds, sorts by label`() {
        val rules = InboxRules(
            chatRooms = mapOf("!zed" to "feed", "!alpha" to "feed"),
            mailSenders = mapOf("news@example.com" to "feed"),
            feedFeeds = mapOf("f1" to "inbox", "gone" to "hidden"),
        )
        val out = listOverrides(
            rules,
            roomNames = mapOf("!zed" to "Zed", "!alpha" to "Alpha"),
            feedTitles = mapOf("f1" to "Hacker News"),
        )
        assertEquals(
            listOf(
                InboxSource.CHAT to "Alpha", InboxSource.CHAT to "Zed",
                InboxSource.MAIL to "news@example.com",
                InboxSource.FEED to "gone", InboxSource.FEED to "Hacker News",
            ),
            out.map { it.source to it.label },
        )
        // An unresolvable key labels as itself; the route rides through verbatim.
        val gone = out.first { it.key == "gone" }
        assertEquals("gone", gone.key)
        assertEquals("hidden", gone.route)
    }

    @Test
    fun `withoutOverride drops exactly one key and is a no-op for agents or unknown keys`() {
        val rules = InboxRules(
            chatRooms = mapOf("!a" to "feed", "!b" to "feed"),
            mailSenders = mapOf("x@y.z" to "feed"),
            feedFeeds = mapOf("f1" to "inbox"),
        )
        val cleared = withoutOverride(rules, InboxSource.CHAT, "!a")
        assertEquals(mapOf("!b" to "feed"), cleared.chatRooms)
        assertEquals("inbox", cleared.routeForRoom("!a"))
        assertEquals(rules.mailSenders, cleared.mailSenders)
        assertEquals(rules.feedFeeds, cleared.feedFeeds)

        assertEquals(emptyMap<String, String>(), withoutOverride(rules, InboxSource.MAIL, "x@y.z").mailSenders)
        assertEquals(emptyMap<String, String>(), withoutOverride(rules, InboxSource.FEED, "f1").feedFeeds)
        assertEquals(rules, withoutOverride(rules, InboxSource.AGENT, "anything"))
        assertEquals(rules, withoutOverride(rules, InboxSource.CHAT, "!missing"))
    }

    @Test
    fun `mail routes key on lowercased sender`() {
        val rules = InboxRules.DEFAULT.copy(mailSenders = mapOf("bob@example.com" to "feed"))
        val t = threadToEntry(thread(fromEmail = "Bob@Example.com"), rules)
        assertFalse(t.inInbox)
        assertEquals("bob@example.com", t.routeKey)
    }
}
