package io.amar.console.data.search

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.BookmarkRow
import io.amar.console.data.db.CalEventRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.db.areaList
import io.amar.console.data.spaces.SpacesRepository
import io.amar.console.ui.nav.Pane
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Pure half of the launcher command bar — SPA `src/commandbar/rank.ts` +
 * the entry composition in `CommandBar.tsx`. Jump to ANYTHING from the grid's
 * search field: a pane, an installed app, an action, a space, a live agent
 * session, a vault file, a chat room, a mail thread, a feed, a bookmark, an
 * upcoming calendar event. Absorbed the Spaces-only switcher (`SpacesSwitcher`).
 *
 * Every source is a Room table (or an already-loaded StateFlow) — no hub
 * call anywhere in the query path, so the bar works offline over whatever the
 * phone has; an empty table contributes nothing.
 */
object CommandBarLogic {
    enum class Kind { PANE, ACTION, APP, AREA, PROJECT, SESSION, FILE, ROOM, THREAD, FEED, BOOKMARK, EVENT, CREATE }

    /** What a pick opens — the UI maps each onto an EXISTING nav primitive. */
    sealed interface Target {
        data class OpenPane(val pane: Pane) : Target
        data class Action(val id: String) : Target
        /** [AppRef.key] — the UI resolves it back to the InstalledApps entry. */
        data class App(val key: String) : Target
        data class Space(val kind: String, val slug: String) : Target
        data class Session(val id: String) : Target
        data class Note(val path: String) : Target
        data class Room(val id: String) : Target
        data class Thread(val id: String) : Target
        data class Feed(val id: String) : Target
        data class Bookmark(val file: String) : Target
        data class Event(val compoundKey: String, val startMs: Long) : Target
        data class CreateNote(val title: String) : Target
    }

    data class Entry(
        val key: String,
        val title: String,
        val hint: String?,
        val kind: Kind,
        /** Activity timestamp (ms). 0 = never / not applicable. Events: start time. */
        val recency: Long,
        val target: Target,
        val isFork: Boolean = false,
        val running: Boolean = false,
        val unread: Boolean = false,
        /** Launch count (apps only) — a tiebreak ahead of recency so the usage
         *  ranking the grid already applies survives into search results. */
        val usage: Int = 0,
    )

    /** Installed app, reduced to what ranking needs (no Drawable/UserHandle). */
    data class AppRef(
        val key: String,
        val label: String,
        val usageCount: Int = 0,
        val lastUsed: Long = 0,
        val workProfile: Boolean = false,
    )

    data class Action(val id: String, val title: String)

    /** The SPA's action rows that have a phone equivalent (no keyboard-shortcut help here). */
    val ACTIONS: List<Action> = listOf(
        Action("compose", "Compose email"),
        Action("event", "New calendar event"),
        Action("bookmark", "Add bookmark"),
        Action("feed", "Add feed"),
        Action("theme", "Toggle dark mode"),
    )

    /** The Money screen's sections (the SPA's sub-tabs that exist on the phone). */
    val MONEY_SECTIONS: List<String> = listOf("Cashflow", "Net worth", "Transactions")

    const val UNASSIGNED_SLUG = "~unassigned"

    /** Kinds that read as "structure" (a place to go) rather than "content":
     *  on an equal fuzzy score they beat content so `mail` lands on the Mail
     *  pane before a thread whose subject starts with "mail". */
    val STRUCTURE: Set<Kind> = setOf(Kind.PANE, Kind.ACTION, Kind.APP, Kind.AREA, Kind.PROJECT)

    /** Kinds shown in the empty-query "Recent" band, in tie-break order. */
    val RECENT_KINDS: List<Kind> = listOf(Kind.SESSION, Kind.FILE, Kind.ROOM, Kind.THREAD)

    const val FILE_CAP = 2000
    const val RESULT_CAP = 50
    const val RECENT_LIMIT = 10
    const val RECENT_PER_KIND = 3
    const val UPCOMING_LIMIT = 3
    /** Mail: how many recent threads are always in the pool (whole-table hits join from 2 chars). */
    const val RECENT_THREADS = 200
    const val THREAD_HITS = 30
    const val UPCOMING_DAYS = 60L
    const val DAY_MS = 86_400_000L

    /**
     * SPA `fuzzyScore`: lower is better, -1 = no match. A contiguous substring
     * scores its index; a scattered subsequence scores 1000 + first hit, so
     * any substring match outranks any subsequence match.
     */
    fun fuzzyScore(text: String, q: String): Int {
        val idx = text.indexOf(q)
        if (idx >= 0) return idx
        var ti = 0
        var qi = 0
        var first = -1
        while (ti < text.length && qi < q.length) {
            if (text[ti] == q[qi]) {
                if (first < 0) first = ti
                qi++
            }
            ti++
        }
        return if (qi == q.length) 1000 + first else -1
    }

    /** Project slug a vault path belongs to (`projects/<slug>/…` or `projects/<slug>.md`). */
    fun projectSlugOf(path: String): String? {
        val m = Regex("""^projects/([^/.]+)""").find(path) ?: return null
        return m.groupValues[1]
    }

    /** Hostname without `www.` for a bookmark hint; null when unparsable. */
    fun hostOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return runCatching { java.net.URI(url).host }.getOrNull()?.removePrefix("www.")?.ifBlank { null }
    }

    /** Upcoming = not cancelled, still running or future, one row per event id
     *  (the same Google event reachable through two accounts is one entry). */
    fun upcomingEvents(rows: List<CalEventRow>, nowMs: Long): List<CalEventRow> {
        val seen = HashSet<String>()
        return rows.filter { it.status != "cancelled" && it.endTime > nowMs && seen.add(it.eventId) }
    }

    private val ALL_DAY_FMT = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ENGLISH)
    private val TIMED_FMT = DateTimeFormatter.ofPattern("EEE d MMM HH:mm", Locale.ENGLISH)

    fun eventHint(ev: CalEventRow, zone: ZoneId): String {
        val t = Instant.ofEpochMilli(ev.startTime).atZone(zone)
        return (if (ev.isAllDay) ALL_DAY_FMT else TIMED_FMT).format(t)
    }

    /** Everything the bar can reach. Each list is optional so a fresh install
     *  (empty tables) simply contributes fewer entries. */
    data class Sources(
        val panes: List<Pane> = Pane.entries,
        val apps: List<AppRef> = emptyList(),
        val spaces: List<SpacesRepository.SpaceSummary> = emptyList(),
        val sessions: List<AgentSessionRow> = emptyList(),
        /** Session ids with a turn in flight (AgentsRepository.activity). */
        val running: Set<String> = emptySet(),
        val files: List<NoteFileRow> = emptyList(),
        val rooms: List<ChatRoomRow> = emptyList(),
        /** Recent threads ∪ whole-table hits for the current query (deduped here). */
        val threads: List<MailThreadRow> = emptyList(),
        val feeds: List<FeedRow> = emptyList(),
        val bookmarks: List<BookmarkRow> = emptyList(),
        /** Already filtered by [upcomingEvents]. */
        val events: List<CalEventRow> = emptyList(),
        val zone: ZoneId = ZoneId.systemDefault(),
    )

    fun build(src: Sources): List<Entry> {
        val out = ArrayList<Entry>(
            src.panes.size + src.apps.size + ACTIONS.size + src.spaces.size + src.sessions.size +
                minOf(src.files.size, FILE_CAP) + src.rooms.size + src.threads.size + src.feeds.size +
                src.bookmarks.size + src.events.size + 8,
        )
        val spaceRecency = HashMap<String, Long>()
        fun bump(slug: String?, ts: Long) {
            if (slug != null && ts > (spaceRecency[slug] ?: 0L)) spaceRecency[slug] = ts
        }

        for (p in src.panes) {
            out.add(Entry("p:${p.route}", p.label, null, Kind.PANE, 0, Target.OpenPane(p)))
        }
        if (Pane.Money in src.panes) {
            for (s in MONEY_SECTIONS) {
                out.add(Entry("p:money:${s.lowercase().replace(' ', '-')}", s, "Money", Kind.PANE, 0, Target.OpenPane(Pane.Money)))
            }
        }
        for (a in ACTIONS) {
            out.add(Entry("a:${a.id}", a.title, null, Kind.ACTION, 0, Target.Action(a.id)))
        }
        for (app in src.apps) {
            out.add(Entry(
                key = "app:${app.key}", title = app.label, hint = if (app.workProfile) "work" else null,
                kind = Kind.APP, recency = app.lastUsed, target = Target.App(app.key), usage = app.usageCount,
            ))
        }
        for (s in src.sessions) {
            if (s.status == "ended") continue
            val slug = s.project ?: s.areaList().firstOrNull()
            val recency = maxOf(s.lastActivityAt, s.createdAt)
            bump(slug, recency)
            val name = s.name.ifBlank { s.id }
            out.add(Entry(
                key = "s:${s.id}", title = name.removeSuffix(" (fork)"), hint = slug, kind = Kind.SESSION,
                recency = recency, target = Target.Session(s.id),
                isFork = s.parentClaudeSessionId != null || name.endsWith(" (fork)"),
                running = s.id in src.running, unread = s.hasUnread,
            ))
        }
        // The cap keeps the RECENT files, not the alphabetically-first ones.
        val files = if (src.files.size > FILE_CAP) src.files.sortedByDescending { it.mtime }.take(FILE_CAP) else src.files
        for (f in files) {
            bump(projectSlugOf(f.path), f.mtime)
            out.add(Entry("f:${f.path}", f.name, f.dir.ifBlank { null }, Kind.FILE, f.mtime, Target.Note(f.path)))
        }
        for (r in src.rooms) {
            out.add(Entry(
                key = "r:${r.id}", title = r.name, hint = if (r.isDirect) null else "group", kind = Kind.ROOM,
                recency = r.lastMessageTime, target = Target.Room(r.id), unread = r.isUnread,
            ))
        }
        val threadIds = HashSet<String>()
        for (t in src.threads) {
            if (!threadIds.add(t.id)) continue
            out.add(Entry(
                key = "t:${t.id}", title = t.subject.ifBlank { "(no subject)" },
                hint = t.fromName.ifBlank { t.fromEmail }.ifBlank { null }, kind = Kind.THREAD,
                recency = t.date, target = Target.Thread(t.id), unread = t.isUnread,
            ))
        }
        for (fd in src.feeds) {
            out.add(Entry("fd:${fd.id}", fd.title, fd.folder, Kind.FEED, 0, Target.Feed(fd.id)))
        }
        for (b in src.bookmarks) {
            out.add(Entry("b:${b.file}", b.title, hostOf(b.url), Kind.BOOKMARK, 0, Target.Bookmark(b.file)))
        }
        for (ev in src.events) {
            out.add(Entry(
                key = "e:${ev.compoundKey}", title = ev.summary.ifBlank { "(untitled)" }, hint = eventHint(ev, src.zone),
                kind = Kind.EVENT, recency = ev.startTime, target = Target.Event(ev.compoundKey, ev.startTime),
            ))
        }
        out.add(Entry("sp:$UNASSIGNED_SLUG", "Unassigned", null, Kind.PROJECT, 0, Target.Space("project", UNASSIGNED_SLUG)))
        for (sp in src.spaces) {
            out.add(Entry(
                key = "sp:${sp.slug}", title = sp.title, hint = null,
                kind = if (sp.kind == "area") Kind.AREA else Kind.PROJECT,
                recency = spaceRecency[sp.slug] ?: 0L, target = Target.Space(sp.kind, sp.slug),
            ))
        }
        return out
    }

    /**
     * SPA `rankEntries`. Empty query = launcher: the most recent things across
     * sessions/files/rooms/threads (per-kind capped so mail can't flood it),
     * the next few calendar events, then every pane and action. Non-empty =
     * one flat fuzzy list over everything, best match first, structure before
     * content on a tie, then app usage, then most recent first.
     */
    fun rank(
        entries: List<Entry>,
        query: String,
        limit: Int = RESULT_CAP,
        recentLimit: Int = RECENT_LIMIT,
        recentPerKind: Int = RECENT_PER_KIND,
        upcomingLimit: Int = UPCOMING_LIMIT,
    ): List<Entry> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) {
            val recent = entries.filter { it.kind in RECENT_KINDS && it.recency > 0 }.sortedByDescending { it.recency }
            val seen = HashMap<Kind, Int>()
            val recentOut = ArrayList<Entry>(recentLimit)
            for (e in recent) {
                if (recentOut.size >= recentLimit) break
                val n = seen[e.kind] ?: 0
                if (n >= recentPerKind) continue
                seen[e.kind] = n + 1
                recentOut.add(e)
            }
            // Upcoming events carry recency = start time; soonest first.
            val upcoming = entries.filter { it.kind == Kind.EVENT }.sortedBy { it.recency }.take(upcomingLimit)
            val structure = entries.filter { it.kind == Kind.PANE || it.kind == Kind.ACTION }
            return recentOut + upcoming + structure
        }
        return entries
            .mapNotNull { e ->
                val score = fuzzyScore("${e.title} ${e.hint ?: ""}".lowercase(), q)
                if (score >= 0) e to score else null
            }
            .sortedWith(
                compareBy<Pair<Entry, Int>> { it.second }
                    .thenBy { if (it.first.kind in STRUCTURE) 0 else 1 }
                    .thenByDescending { it.first.usage }
                    .thenByDescending { it.first.recency },
            )
            .take(limit)
            .map { it.first }
    }

    /** The trailing create-note escape hatch the SPA appends to every non-empty result list. */
    fun createEntry(query: String): Entry? {
        val q = query.trim()
        if (q.isEmpty()) return null
        return Entry("~create", "New note: “$q”", null, Kind.CREATE, 0, Target.CreateNote(q))
    }

    enum class Section(val label: String) { RECENT("Recent"), UPCOMING("Upcoming"), GO_TO("Go to") }

    /** Section a row belongs to in the empty-query launcher (SPA `launcherSection`). */
    fun launcherSection(kind: Kind): Section = when (kind) {
        Kind.EVENT -> Section.UPCOMING
        Kind.PANE, Kind.ACTION -> Section.GO_TO
        else -> Section.RECENT
    }

    /** Kinds whose recency is a real "last touched" moment worth printing beside the row. */
    val TIMESTAMPED: Set<Kind> = setOf(Kind.SESSION, Kind.FILE, Kind.ROOM, Kind.THREAD)
}
