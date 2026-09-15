package io.amar.console.data.search

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.BookmarkRow
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.search.CommandBarLogic.AppRef
import io.amar.console.data.search.CommandBarLogic.Kind
import io.amar.console.data.search.CommandBarLogic.Section
import io.amar.console.data.search.CommandBarLogic.Sources
import io.amar.console.data.search.CommandBarLogic.Target
import io.amar.console.data.spaces.SpacesRepository
import io.amar.console.ui.nav.Pane
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** Pure port of SPA `src/commandbar/rank.ts` + `CommandBar.tsx` entry composition. */
class CommandBarLogicTest {
    private fun session(
        id: String, name: String, project: String? = null, areas: String? = null,
        status: String = "idle", createdAt: Long = 0, lastActivityAt: Long = 0, parent: String? = null,
        unread: Boolean = false,
    ) = AgentSessionRow(
        id = id, name = name, status = status, hasUnread = unread, needsAttention = false,
        attentionSnippet = null, agentKey = null, modelLabel = null, hibernated = false, cwd = null,
        lastCachedIndex = 0, messageLogLength = 0, parentClaudeSessionId = parent,
        createdAt = createdAt, lastActivityAt = lastActivityAt, project = project, areasCsv = areas,
    )

    private fun file(path: String, mtime: Long) = NoteFileRow(
        path = path, name = path.substringAfterLast('/'), dir = path.substringBeforeLast('/', ""),
        mtime = mtime, size = 0, cachedContent = null, contentMtime = null,
    )

    private fun space(kind: String, slug: String, title: String = slug) = SpacesRepository.SpaceSummary(
        kind = kind, slug = slug, title = title, notePath = null, boardPath = null, status = null, fileCount = 0,
    )

    private fun room(id: String, name: String, direct: Boolean = true, last: Long = 0, unread: Boolean = false) = ChatRoomRow(
        id = id, name = name, avatarMxc = null, isDirect = direct, isUnread = unread, unreadCount = 0, manualUnread = false,
        lastMessageBody = null, lastMessageSender = null, lastMessageTime = last, lastReadEventId = null,
        isMuted = false, isLowPriority = false, isEncrypted = false, memberCount = 2, networkIcon = null,
        snoozedUntil = null, prevBatch = null, rawJson = "{}",
    )

    private fun thread(id: String, subject: String, from: String = "Alice", date: Long = 0, unread: Boolean = false) = MailThreadRow(
        id = id, subject = subject, fromName = from, fromEmail = "a@x.io", snippet = "", date = date, isUnread = unread,
        isInbox = true, hasAttachments = false, messageCount = 1, snoozedUntil = null, account = "me",
    )

    private fun feed(id: String, title: String, folder: String? = null) = FeedRow(id = id, title = title, folder = folder)

    private fun bookmark(file: String, title: String, url: String?) =
        BookmarkRow(file = file, title = title, url = url, tagsJson = null, addedAt = 0)

    private fun event(key: String, summary: String, start: Long, end: Long, allDay: Boolean = false, status: String = "confirmed", eventId: String = key) =
        CalEventRow(
            compoundKey = key, accountEmail = "me", calendarId = "cal", eventId = eventId, summary = summary, location = null,
            startTime = start, endTime = end, isAllDay = allDay, status = status, rawJson = "{}",
        )

    private val UTC = ZoneId.of("UTC")

    // --- fuzzyScore (SPA semantics: lower = better, -1 = miss) ---

    @Test fun `contiguous substring scores its index`() {
        assertEquals(0, CommandBarLogic.fuzzyScore("console board", "con"))
        assertEquals(8, CommandBarLogic.fuzzyScore("console board", "board"))
    }

    @Test fun `scattered subsequence scores 1000 plus first hit and always loses to a substring`() {
        val sub = CommandBarLogic.fuzzyScore("console board", "cb")
        assertEquals(1000, sub)
        assertTrue(CommandBarLogic.fuzzyScore("zzzz console", "console") < sub)
    }

    @Test fun `no subsequence is a miss`() {
        assertEquals(-1, CommandBarLogic.fuzzyScore("console", "xyz"))
        assertEquals(-1, CommandBarLogic.fuzzyScore("ab", "ba"))
    }

    // --- build ---

    @Test fun `every pane is an entry plus the Money sections and the actions`() {
        val entries = CommandBarLogic.build(Sources())
        val panes = entries.filter { it.kind == Kind.PANE }
        assertEquals(Pane.entries.size + CommandBarLogic.MONEY_SECTIONS.size, panes.size)
        assertEquals(Target.OpenPane(Pane.Money), panes.first { it.title == "Net worth" }.target)
        assertEquals("Money", panes.first { it.title == "Net worth" }.hint)
        assertEquals(CommandBarLogic.ACTIONS.map { "a:${it.id}" }, entries.filter { it.kind == Kind.ACTION }.map { it.key })
        // The Unassigned pseudo-space is always present; no Vault pseudo-space on the phone.
        assertEquals(Target.Space("project", "~unassigned"), entries.single { it.kind == Kind.PROJECT }.target)
    }

    @Test fun `apps carry usage and work-profile hint`() {
        val entries = CommandBarLogic.build(Sources(apps = listOf(AppRef("k1", "Maps", usageCount = 7, lastUsed = 99, workProfile = true))))
        val app = entries.single { it.kind == Kind.APP }
        assertEquals("app:k1", app.key)
        assertEquals("work", app.hint)
        assertEquals(7, app.usage)
        assertEquals(99L, app.recency)
        assertEquals(Target.App("k1"), app.target)
    }

    @Test fun `ended sessions are excluded and forks flagged`() {
        val entries = CommandBarLogic.build(Sources(
            sessions = listOf(
                session("a", "Live one", status = "idle"),
                session("b", "Dead one", status = "ended"),
                session("c", "Child (fork)", parent = "csid-a", unread = true),
            ),
            running = setOf("a"),
        )).filter { it.kind == Kind.SESSION }
        assertEquals(listOf("s:a", "s:c"), entries.map { it.key })
        assertEquals("Child", entries[1].title)
        assertTrue(entries[1].isFork)
        assertTrue(entries[1].unread)
        assertFalse(entries[0].isFork)
        assertTrue(entries[0].running)
        assertFalse(entries[1].running)
    }

    @Test fun `a space inherits the recency of its most recent session or file`() {
        val entries = CommandBarLogic.build(Sources(
            spaces = listOf(space("project", "console"), space("area", "health"), space("project", "quiet")),
            sessions = listOf(
                session("a", "Console general", project = "console", createdAt = 10, lastActivityAt = 50),
                session("b", "Yoga", areas = "health,fitness", createdAt = 70),
            ),
            files = listOf(file("projects/console/board.md", 90), file("projects/quiet.md", 5)),
        ))
        val bySlug = entries.filter { it.kind == Kind.AREA || it.kind == Kind.PROJECT }.associateBy { (it.target as Target.Space).slug }
        assertEquals(90L, bySlug["console"]!!.recency) // file mtime beats session activity
        assertEquals(70L, bySlug["health"]!!.recency)  // first area of the session's list
        assertEquals(Kind.AREA, bySlug["health"]!!.kind)
        assertEquals(5L, bySlug["quiet"]!!.recency)    // flat project note
        assertEquals("console", entries.first { it.key == "s:a" }.hint)
        assertEquals("health", entries.first { it.key == "s:b" }.hint)
    }

    @Test fun `file cap keeps the most recent files not the alphabetically first`() {
        val files = (1..(CommandBarLogic.FILE_CAP + 5)).map { file("a/n$it.md", it.toLong()) }
        val kept = CommandBarLogic.build(Sources(files = files)).filter { it.kind == Kind.FILE }
        assertEquals(CommandBarLogic.FILE_CAP, kept.size)
        assertTrue(kept.none { it.recency <= 5 })
    }

    @Test fun `rooms threads feeds bookmarks and events map fields and dedupe threads`() {
        val entries = CommandBarLogic.build(Sources(
            rooms = listOf(room("!r", "Mum", direct = true, last = 5, unread = true), room("!g", "Family", direct = false)),
            threads = listOf(thread("t1", "Invoice", date = 3, unread = true), thread("t1", "Invoice"), thread("t2", "", from = "")),
            feeds = listOf(feed("f1", "Hacker News", folder = "Tech")),
            bookmarks = listOf(bookmark("b.md", "Kotlin docs", "https://www.kotlinlang.org/docs"), bookmark("c.md", "No url", null)),
            events = listOf(event("e1", "Standup", start = 1_700_000_000_000, end = 1_700_003_600_000)),
            zone = UTC,
        ))
        val mum = entries.first { it.key == "r:!r" }
        assertNull(mum.hint); assertTrue(mum.unread); assertEquals(5L, mum.recency)
        assertEquals("group", entries.first { it.key == "r:!g" }.hint)
        val threads = entries.filter { it.kind == Kind.THREAD }
        assertEquals(listOf("t:t1", "t:t2"), threads.map { it.key })
        assertEquals("Alice", threads[0].hint); assertTrue(threads[0].unread)
        assertEquals("(no subject)", threads[1].title); assertEquals("a@x.io", threads[1].hint)
        assertEquals("Tech", entries.first { it.key == "fd:f1" }.hint)
        assertEquals("kotlinlang.org", entries.first { it.key == "b:b.md" }.hint)
        assertNull(entries.first { it.key == "b:c.md" }.hint)
        val ev = entries.first { it.kind == Kind.EVENT }
        assertEquals("Tue 14 Nov 22:13", ev.hint)
        assertEquals(1_700_000_000_000L, ev.recency)
        assertEquals(Target.Event("e1", 1_700_000_000_000L), ev.target)
    }

    @Test fun `event hint for all-day rows has no time`() {
        val ev = event("e", "Birthday", start = 1_700_006_400_000, end = 1_700_092_800_000, allDay = true)
        assertEquals("Wed 15 Nov", CommandBarLogic.eventHint(ev, UTC))
    }

    @Test fun `upcomingEvents drops cancelled and ended rows and dedupes by event id`() {
        val now = 1_000L
        val rows = listOf(
            event("a:x", "Live", start = 500, end = 1_500, eventId = "x"),
            event("b:x", "Live via other account", start = 500, end = 1_500, eventId = "x"),
            event("c", "Ended", start = 100, end = 900),
            event("d", "Cancelled", start = 2_000, end = 3_000, status = "cancelled"),
            event("e", "Future", start = 5_000, end = 6_000),
        )
        assertEquals(listOf("a:x", "e"), CommandBarLogic.upcomingEvents(rows, now).map { it.compoundKey })
    }

    // --- rank: empty query = launcher ---

    @Test fun `empty query is Recent per-kind capped then Upcoming soonest-first then panes and actions`() {
        val entries = CommandBarLogic.build(Sources(
            panes = listOf(Pane.Inbox, Pane.Mail),
            sessions = listOf(session("s1", "S1", lastActivityAt = 100), session("s2", "S2", lastActivityAt = 90)),
            files = listOf(file("a.md", 95)),
            threads = (1..6).map { thread("t$it", "Mail $it", date = 200L + it) }, // newest of all, but capped at 3
            rooms = listOf(room("!r", "Room", last = 0)),                          // recency 0 → never Recent
            events = listOf(event("late", "Later", 900, 950), event("soon", "Soon", 300, 400)),
            zone = UTC,
        ))
        val ranked = CommandBarLogic.rank(entries, "")
        val recent = ranked.takeWhile { CommandBarLogic.launcherSection(it.kind) == Section.RECENT }
        assertEquals(listOf("t:t6", "t:t5", "t:t4", "s:s1", "f:a.md", "s:s2"), recent.map { it.key })
        val upcoming = ranked.filter { it.kind == Kind.EVENT }
        assertEquals(listOf("e:soon", "e:late"), upcoming.map { it.key })
        val goTo = ranked.filter { CommandBarLogic.launcherSection(it.kind) == Section.GO_TO }
        assertTrue(goTo.first().key.startsWith("p:"))
        assertEquals(2 + CommandBarLogic.ACTIONS.size, goTo.size) // no Money sections without the Money pane
        // Apps, spaces, feeds, bookmarks never appear in the empty-query launcher.
        assertTrue(ranked.none { it.kind == Kind.APP || it.kind == Kind.PROJECT || it.kind == Kind.FEED })
    }

    @Test fun `recent band honours the overall limit`() {
        val entries = CommandBarLogic.build(Sources(
            panes = emptyList(),
            sessions = (1..5).map { session("s$it", "S$it", lastActivityAt = it.toLong()) },
            files = (1..5).map { file("f$it.md", it.toLong()) },
            rooms = (1..5).map { room("!r$it", "R$it", last = it.toLong()) },
            threads = (1..5).map { thread("t$it", "T$it", date = it.toLong()) },
        ))
        val ranked = CommandBarLogic.rank(entries, "", recentLimit = 4, recentPerKind = 3)
        assertEquals(4, ranked.count { CommandBarLogic.launcherSection(it.kind) == Section.RECENT })
    }

    // --- rank: query ---

    @Test fun `query ranks by score then structure before content then recency`() {
        val entries = CommandBarLogic.build(Sources(
            panes = listOf(Pane.Mail),
            threads = listOf(thread("t", "Mail merge", date = 999)),
            rooms = listOf(room("!r", "Mailing list", last = 50)),
            files = listOf(file("mail.md", 10)),
        ))
        val ranked = CommandBarLogic.rank(entries, "mail")
        // All score 0; the pane (structure) wins, then content by recency.
        // ("Compose email" trails — its substring hit sits at index 9.)
        assertEquals(listOf("p:mail", "t:t", "r:!r", "f:mail.md", "a:compose"), ranked.map { it.key })
    }

    @Test fun `apps are structure and break ties by usage before recency`() {
        val entries = CommandBarLogic.build(Sources(
            panes = emptyList(),
            apps = listOf(
                AppRef("a", "Signal", usageCount = 1, lastUsed = 999),
                AppRef("b", "Simple Gallery", usageCount = 9, lastUsed = 1),
            ),
            rooms = listOf(room("!r", "Simon", last = 5_000)),
        ))
        val ranked = CommandBarLogic.rank(entries, "si")
        assertEquals(listOf("app:b", "app:a", "r:!r"), ranked.take(3).map { it.key })
    }

    @Test fun `query matches the hint too and drops misses`() {
        val entries = CommandBarLogic.build(Sources(
            panes = emptyList(),
            sessions = listOf(session("hint", "Mobile app", project = "console", lastActivityAt = 99)),
            files = listOf(file("scratch/unrelated.md", 500)),
        ))
        val ranked = CommandBarLogic.rank(entries, "console")
        assertEquals(listOf("s:hint"), ranked.map { it.key })
    }

    @Test fun `query is case-insensitive trimmed and capped`() {
        val entries = CommandBarLogic.build(Sources(
            panes = emptyList(),
            files = (1..80).map { file("scratch/demo$it.md", it.toLong()) },
        ))
        val ranked = CommandBarLogic.rank(entries, "  DEMO ")
        assertEquals(CommandBarLogic.RESULT_CAP, ranked.size)
        assertEquals("f:scratch/demo80.md", ranked.first().key) // equal score → most recent first
    }

    @Test fun `create entry only for a non-empty query`() {
        assertNull(CommandBarLogic.createEntry("   "))
        val e = CommandBarLogic.createEntry(" Plan ")!!
        assertEquals(Kind.CREATE, e.kind)
        assertEquals("New note: “Plan”", e.title)
        assertEquals(Target.CreateNote("Plan"), e.target)
    }

    @Test fun `helpers - projectSlugOf and hostOf`() {
        assertEquals("console", CommandBarLogic.projectSlugOf("projects/console/board.md"))
        assertEquals("quiet", CommandBarLogic.projectSlugOf("projects/quiet.md"))
        assertNull(CommandBarLogic.projectSlugOf("scratch/lists/movies.md"))
        assertEquals("example.com", CommandBarLogic.hostOf("https://www.example.com/x?y=1"))
        assertNull(CommandBarLogic.hostOf("not a url"))
        assertNull(CommandBarLogic.hostOf(null))
    }
}
