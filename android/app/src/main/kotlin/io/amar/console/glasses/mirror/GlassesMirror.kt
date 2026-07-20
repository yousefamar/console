package io.amar.console.glasses.mirror

import android.content.Context
import android.content.SharedPreferences
import io.amar.console.ConsoleApp
import io.amar.console.core.AppLifecycle
import io.amar.console.data.db.ConsoleDb
import io.amar.console.glasses.GlassesController
import io.amar.console.glasses.GlassesEvents
import io.amar.console.glasses.mirror.MirrorText.Frame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Native port of the SPA's app-wide glasses mirror (src/glasses/mirror.ts):
 * renders whatever pane/route the user is on to the G1 lenses, 5×40.
 *
 * Trigger points: route changes (AppShell feeds currentRoute → [poke]),
 * composer keystrokes ([setComposerText]), editor cursor moves
 * ([setEditorCursor]), and — new for parity — data-change pokes via [poke]
 * called from any repo subscription. The scheduler is a single 30 ms
 * coalescing tick; identical frames aren't re-sent.
 *
 * Body building dispatches per active pane through per-pane renderers that mirror
 * the SPA's per-pane renderers, reading the current state from the Room DAOs plus the
 * in-memory repo StateFlows reached lazily via ConsoleApp.graph (agents
 * activity/approvals, dashboard alerts, map/geocaches, bookmarks). The
 * keystroke → BLE path never touches the hub (≤100 ms), same as the SPA.
 */
class GlassesMirror(
    private val context: Context,
    private val scope: CoroutineScope,
    private val db: ConsoleDb,
) {
    companion object {
        private const val PREFS = "glasses_mirror"
        private const val KEY_ENABLED = "enabled"
        private const val DEBOUNCE_MS = 30L
    }

    private val json = Json { ignoreUnknownKeys = true }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _enabled = MutableStateFlow(prefs.getBoolean(KEY_ENABLED, false))
    val enabledFlow: StateFlow<Boolean> = _enabled
    val enabled: Boolean get() = _enabled.value

    /** Per-pane composer echo (chat/agents screens push keystrokes here). */
    @Volatile private var composerText: String = ""
    /** Live editor cursor snapshot for the notes cursor-follow window. */
    @Volatile private var editorState: EditorSnapshot? = null
    @Volatile private var lastSentPayload: String = ""
    private var pending: Job? = null
    /** Set by MainActivity so the mirror can drive the stealth-dim window. */
    var applyDim: ((Boolean) -> Unit)? = null

    /** Lazily-resolved repo graph for in-memory (non-DB) pane state. Null in
     *  unit tests / non-ConsoleApp contexts — renderers degrade gracefully. */
    private val graph get() = (context.applicationContext as? ConsoleApp)?.graph

    init {
        // Head-down after a hub HUD / notification card clears the lenses — the
        // firmware leaves them blank. Re-assert the mirror so the user isn't
        // left staring at a dead panel. Port of mirror.ts's onG1Event handler.
        GlassesEvents.addEventListener { _, kind ->
            if (kind == GlassesEvents.Kind.HEAD_DOWN && enabled) pushNow()
        }
    }

    fun setEnabled(on: Boolean) {
        _enabled.value = on
        prefs.edit().putBoolean(KEY_ENABLED, on).apply()
        applyDim?.invoke(on)
        if (on) poke() else clearLenses()
    }

    /** Re-assert persisted state on boot (dim + first frame). */
    fun onBoot() {
        if (enabled) {
            applyDim?.invoke(true)
            poke()
        }
        wireDataPokes()
    }

    /**
     * Data-change → re-render pokes (SPA: mirror subscribes to every pane
     * store). The SPA re-renders on any pane store `set()`; here we collect the
     * DB Flows that back the mirror renderers and [poke] on change. Handlers
     * short-circuit on the `enabled` boolean, so cost is one branch when off.
     * Idempotent — the boolean guard makes double-calls harmless.
     */
    @Volatile private var dataWired = false
    private fun wireDataPokes() {
        if (dataWired) return
        dataWired = true
        // Chat rooms + mail inbox + calendar-ish churn all surface via these
        // aggregate flows; per-room/thread message flows aren't collected here
        // (route/composer pokes cover the open-item case). New chat messages in
        // the OPEN room already poke via the composer path on keystroke; the
        // room-list flow catches previews/unread changes.
        scope.launch { db.chatRooms().observeAll().collect { if (enabled) poke() } }
        scope.launch { db.mailThreads().observeInbox(System.currentTimeMillis()).collect { if (enabled) poke() } }
        scope.launch { db.feeds().observeRecent(1).collect { if (enabled) poke() } }
        scope.launch { db.bookmarks().observeAll().collect { if (enabled) poke() } }
        // Agent transcript churn (streaming assistant text lands as message rows).
        scope.launch { db.agents().observeSessions().collect { if (enabled) poke() } }
    }

    fun setComposerText(text: String) {
        composerText = text
        poke()
    }

    /** Notes cursor-follow feed — CM6-equivalent (doc lines + cursor). The
     *  editor screen pushes this on each edit/selection change. */
    data class EditorSnapshot(
        val path: String?,
        val lines: List<String>,
        val cursorLine: Int, // 1-based
        val cursorCol: Int,  // 0-based within the line
    )

    fun setEditorCursor(snapshot: EditorSnapshot?) {
        editorState = snapshot
        poke()
    }

    /** Coalescing scheduler: any state poke collapses into one BLE write. */
    fun poke() {
        if (!enabled) return
        pending?.cancel()
        pending = scope.launch {
            delay(DEBOUNCE_MS)
            renderAndSend()
        }
    }

    /** Immediate push (no debounce) — used when toggling on / on head-down. */
    fun pushNow() {
        if (!enabled) return
        pending?.cancel()
        pending = scope.launch { renderAndSend() }
    }

    private fun clearLenses() {
        if (GlassesController.isReady()) runCatching { GlassesController.sendExit() }
        lastSentPayload = ""
    }

    private suspend fun renderAndSend() {
        if (!GlassesController.isReady()) return
        val frame = renderRoute(AppLifecycle.currentRoute) ?: return
        val payload = MirrorText.assemble(frame)
        if (payload == lastSentPayload) return // dedupe unchanged frames
        lastSentPayload = payload
        runCatching { GlassesController.sendText(payload) }
    }

    // ------------------------------------------------------------------ //
    // Per-route renderers (ports of the SPA per-pane renderers).

    internal suspend fun renderRoute(route: String): Frame? = when {
        route.startsWith("chat/") -> renderChatRoom(route.removePrefix("chat/"))
        route == "chat" -> renderChatList()
        route.startsWith("agents/") -> renderAgentSession(route.removePrefix("agents/"))
        route.startsWith("agents") -> renderAgentsList()
        route.startsWith("mail/") -> renderMailThread(route.removePrefix("mail/"))
        route.startsWith("mail") -> renderMailInbox()
        route.startsWith("calendar") -> renderCalendar()
        route.startsWith("feeds/") -> renderFeedItem(route.removePrefix("feeds/"))
        route.startsWith("feeds") -> renderFeedsList()
        route.startsWith("bookmarks") -> renderBookmarks()
        route.startsWith("map") -> renderMap()
        route.startsWith("home") -> renderHome()
        route.startsWith("notes/") -> renderNotes()
        route.startsWith("notes") -> renderNotes()
        else -> Frame(MirrorText.buildStatus(listOf("Console", route.ifEmpty { "grid" })), emptyList())
    }

    // --- Chat (src/glasses/panes/chat.ts) --- //

    private suspend fun renderChatRoom(roomId: String): Frame {
        val room = db.chatRooms().byId(roomId)
        val messages = db.chatMessages().recent(roomId, 12)
            .filter { !it.isDeleted && (it.msgtype == "m.text" || it.msgtype == "m.image") }
            .take(3)
            .reversed()
        val body = messages.map { m ->
            val who = MirrorText.shortName(m.senderName ?: m.senderId)
            val text = if (m.msgtype == "m.image") "[image]" else (m.body ?: "")
            MirrorText.clipRow("$who: $text")
        } + MirrorText.composerRow(composerText)
        return Frame(
            MirrorText.buildStatus(
                listOf("Chat", room?.name ?: roomId, room?.unreadCount?.takeIf { it > 0 }?.let { "${it}u" }),
            ),
            body,
        )
    }

    private suspend fun renderChatList(): Frame {
        val rooms = db.chatRooms().allIds().size
        return Frame(MirrorText.buildStatus(listOf("Chat", "$rooms rooms")), emptyList())
    }

    // --- Agents (src/glasses/panes/agents.ts) --- //

    private suspend fun renderAgentSession(sessionId: String): Frame {
        val session = db.agents().byId(sessionId)
        val composer = MirrorText.composerRow(composerText)
        if (session == null) {
            return Frame(MirrorText.buildStatus(listOf("Agents", "no session")), listOf(composer))
        }
        val name = session.name.ifBlank { session.id.take(8) }

        val g = graph
        val approval = g?.agents?.approvals?.value?.firstOrNull { it.sessionId == session.id }
        val activity = g?.agents?.activity?.value?.get(session.id)
        val statusGlyph = when {
            approval != null -> "approve ${approval.toolName}?"
            activity?.running == true -> (activity.statusText ?: activity.currentTool?.let { "⚙ $it" } ?: "running…")
            else -> session.status
        }

        // Last assistant text / tool activity from cached transcript.
        val recent = db.agents().recent(session.id, 12)
        val lastText = lastAssistantText(recent) + (activity?.streamingText ?: "")
        val flat = lastText.replace(Regex("\\s+"), " ").trim()

        // Body budget: BODY_ROWS - 1 (composer) - 1 (status) = text rows.
        val textRows = MirrorText.BODY_ROWS - 2
        val wrapped = if (flat.isNotEmpty()) MirrorText.wrapLine(flat).takeLast(textRows) else emptyList()
        val textBlock = ArrayList<String>()
        while (textBlock.size + wrapped.size < textRows) textBlock.add("")
        textBlock.addAll(wrapped)

        return Frame(
            MirrorText.buildStatus(listOf("Agents", name)),
            textBlock.map { MirrorText.clipRow(it) } + MirrorText.clipRow("· $statusGlyph") + composer,
        )
    }

    private fun lastAssistantText(rows: List<io.amar.console.data.db.AgentMessageRow>): String {
        for (r in rows) { // rows are newest-first from recent()
            when (r.kind) {
                "text" -> parseField(r.payloadJson, "content", "text")?.let { if (it.isNotBlank()) return it }
                "tool_use" -> parseField(r.payloadJson, "toolName")?.let { if (it.isNotBlank()) return "⚙ $it" }
                "status" -> parseField(r.payloadJson, "text", "content")?.let { if (it.isNotBlank()) return it }
            }
        }
        return ""
    }

    private suspend fun renderAgentsList(): Frame {
        val sessions = runCatching { db.agents().allSessions() }.getOrDefault(emptyList())
        val running = sessions.count { it.status == "running" }
        return Frame(
            MirrorText.buildStatus(listOf("Agents", "${sessions.size} sess", running.takeIf { it > 0 }?.let { "$it running" })),
            emptyList(),
        )
    }

    // --- Mail (src/glasses/panes/mail.ts) --- //

    private suspend fun renderMailThread(threadId: String): Frame {
        val thread = db.mailThreads().byId(threadId)
        val msgs = db.mailMessages().forThread(threadId)
        val latest = msgs.lastOrNull()
        val unread = db.mailThreads().inboxIds().size // approximation; refined by list view
        val subject = thread?.subject?.ifBlank { null } ?: "(no subject)"
        val from = senderShort(latest?.fromHeader ?: thread?.fromEmail)
        val snippet = (latest?.bodyText ?: thread?.snippet ?: "").replace(Regex("\\s+"), " ").trim()

        val subjectRows = MirrorText.wrapLine(subject).take(1)
        val fromRow = if (from.isNotEmpty()) MirrorText.clipRow("↳ $from") else null
        val snippetBudget = MirrorText.BODY_ROWS - subjectRows.size - (if (fromRow != null) 1 else 0)
        val snippetRows = if (snippet.isNotEmpty()) MirrorText.wrapLine(snippet).take(snippetBudget.coerceAtLeast(0)) else emptyList()
        val body = subjectRows + listOfNotNull(fromRow) + snippetRows
        return Frame(MirrorText.buildStatus(listOf("Mail", "open")), body)
    }

    private suspend fun renderMailInbox(): Frame {
        // observeInbox is a Flow; snapshot the current inbox rows.
        val rows = runCatching {
            db.mailThreads().observeInbox(System.currentTimeMillis()).first()
        }.getOrDefault(emptyList())
        val unread = rows.count { it.isUnread }
        val top = rows.filter { it.isUnread }.take(MirrorText.BODY_ROWS)
        val body = top.map { MirrorText.clipRow("${senderShort(it.fromName.ifBlank { it.fromEmail }).ifEmpty { "?" }}: ${it.subject.ifBlank { "(no subject)" }}") }
        return Frame(
            MirrorText.buildStatus(listOf("Mail", "inbox", if (unread > 0) "${unread}u" else "zero")),
            body,
        )
    }

    private fun senderShort(from: String?): String {
        if (from.isNullOrEmpty()) return ""
        // `"Name" <addr>` → Name; else local-part of addr.
        val m = Regex("^\\s*\"?([^\"<]+?)\"?\\s*<([^>]+)>\\s*$").find(from)
        if (m != null) return m.groupValues[1].trim()
        val at = from.indexOf('@')
        return if (at > 0) from.substring(0, at) else from
    }

    // --- Calendar (src/glasses/panes/calendar.ts) --- //

    private suspend fun renderCalendar(): Frame {
        val now = System.currentTimeMillis()
        // Upcoming events (visible calendars) starting >= now-60m, within ~30d.
        val rows = runCatching {
            db.calendar().observeEventsInRange(now - 60 * 60_000L, now + 30L * 24 * 3600_000L).first()
        }.getOrDefault(emptyList())
        val visibleIds = graph?.calendar?.visibleIds?.value
        val visible = rows.filter { visibleIds == null || visibleIds.contains("${it.accountEmail}:${it.calendarId}") }
        val upcoming = visible.filter { it.startTime >= now - 60 * 60_000L }.sortedBy { it.startTime }.take(MirrorText.BODY_ROWS)
        val body = upcoming.map { MirrorText.clipRow("${fmtEventTime(it.startTime, it.isAllDay)}  ${it.summary.ifBlank { "(no title)" }}") }
        return Frame(
            MirrorText.buildStatus(listOf("Calendar", if (upcoming.isEmpty()) "clear" else "upcoming")),
            body,
        )
    }

    private fun fmtEventTime(startMs: Long, allDay: Boolean): String {
        val d = Date(startMs)
        if (allDay) return SimpleDateFormat("dd MMM", Locale.UK).format(d)
        val today = SimpleDateFormat("yyyyMMdd", Locale.UK)
        val same = today.format(d) == today.format(Date())
        return if (same) SimpleDateFormat("HH:mm", Locale.UK).format(d)
        else SimpleDateFormat("dd MMM HH:mm", Locale.UK).format(d)
    }

    // --- Feeds (src/glasses/panes/feeds.ts) --- //

    private suspend fun renderFeedItem(itemId: String): Frame {
        val item = db.feeds().itemById(itemId)
            ?: return Frame(MirrorText.buildStatus(listOf("Feeds", "read")), emptyList())
        val titleRows = MirrorText.wrapLine(item.title).take(2)
        val snippet = (item.snippet ?: "").replace(Regex("\\s+"), " ").trim()
        val snippetBudget = MirrorText.BODY_ROWS - titleRows.size
        val snippetRows = if (snippet.isNotEmpty()) MirrorText.wrapLine(snippet).take(snippetBudget.coerceAtLeast(0)) else emptyList()
        return Frame(MirrorText.buildStatus(listOf("Feeds", "read")), titleRows + snippetRows)
    }

    private suspend fun renderFeedsList(): Frame {
        val items = runCatching { db.feeds().observeRecent(50).first() }.getOrDefault(emptyList())
        val readIds = runCatching { db.feeds().observeReadIds().first().toSet() }.getOrDefault(emptySet())
        val feeds = runCatching { db.feeds().observeFeeds().first() }.getOrDefault(emptyList())
        val feedTitles = feeds.associate { it.id to it.title }
        val unread = items.count { it.id !in readIds }
        val top = items.take(MirrorText.BODY_ROWS)
        val body = top.map {
            val ft = feedTitles[it.feedId]
            val label = if (!ft.isNullOrEmpty()) "${ft.take(14)}: " else ""
            MirrorText.clipRow("$label${it.title}")
        }
        return Frame(
            MirrorText.buildStatus(listOf("Feeds", "all", if (unread > 0) "${unread}u" else null)),
            body,
        )
    }

    // --- Bookmarks (src/glasses/panes/bookmarks.ts) --- //

    private suspend fun renderBookmarks(): Frame {
        val rows = runCatching { db.bookmarks().observeAll().first() }.getOrDefault(emptyList())
        val top = rows.take(MirrorText.BODY_ROWS)
        val body = top.map { MirrorText.clipRow(it.title) }
        return Frame(MirrorText.buildStatus(listOf("Bookmarks", "${rows.size}")), body)
    }

    // --- Map (src/glasses/panes/map.ts) --- //

    private suspend fun renderMap(): Frame {
        val state = graph?.map?.state?.value
        val me = state?.current?.firstOrNull()
        val meLabel = me?.let { "${"%.3f".format(it.lat)},${"%.3f".format(it.lon)}" }
        val selectedCode = state?.selectedCode
        if (selectedCode != null) {
            val c = state.pins.firstOrNull { it.code == selectedCode }
            if (c != null) {
                val body = listOf(
                    MirrorText.clipRow(c.name),
                    MirrorText.clipRow("${c.code} ${c.type}"),
                    MirrorText.clipRow("D${c.difficulty} T${c.terrain} ${c.size}"),
                    MirrorText.clipRow(
                        c.detail?.hint?.takeIf { it.isNotBlank() }?.let { "hint: $it" }
                            ?: c.owner.takeIf { it.isNotBlank() }?.let { "by $it" } ?: "",
                    ),
                ).take(MirrorText.BODY_ROWS)
                return Frame(MirrorText.buildStatus(listOf("Map", c.code)), body)
            }
        }
        val pinCount = state?.pins?.size ?: 0
        val body = listOf(
            MirrorText.clipRow(if (me != null) "me $meLabel" else "no location"),
            MirrorText.clipRow("$pinCount caches loaded"),
        )
        return Frame(MirrorText.buildStatus(listOf("Map", me?.device, meLabel)), body)
    }

    // --- Home (src/glasses/panes/home.ts) --- //

    private suspend fun renderHome(): Frame {
        val home = graph?.home?.state?.value
        val alerts = home?.alerts ?: emptyList()
        if (alerts.isEmpty()) {
            val sessions = home?.snapshot?.hub?.sessions ?: 0
            return Frame(
                MirrorText.buildStatus(listOf("Home", "all clear")),
                listOf(MirrorText.clipRow("hub up · $sessions session${if (sessions == 1) "" else "s"}")),
            )
        }
        val now = System.currentTimeMillis()
        val body = alerts.take(MirrorText.BODY_ROWS).map { a ->
            when (a) {
                is io.amar.console.data.longtail.DashboardAlert.Approval ->
                    MirrorText.clipRow("? ${a.sessionName ?: "agent"}: ${a.question ?: a.toolName}")
                is io.amar.console.data.longtail.DashboardAlert.Upcoming -> {
                    val mins = ((a.startMs - now) / 60000L).coerceAtLeast(0)
                    MirrorText.clipRow("@ ${mins}m ${a.summary}")
                }
                is io.amar.console.data.longtail.DashboardAlert.Err ->
                    MirrorText.clipRow("! ${a.message}")
            }
        }
        return Frame(
            MirrorText.buildStatus(listOf("Home", "${alerts.size} alert${if (alerts.size == 1) "" else "s"}")),
            body,
        )
    }

    // --- Notes cursor-follow (src/glasses/panes/notes.ts) --- //

    private fun renderNotes(): Frame {
        val ed = editorState
        val file = ed?.path?.let { basename(it) }
        if (ed == null || ed.lines.isEmpty()) {
            return Frame(MirrorText.buildStatus(listOf("Notes", file ?: "no file open")), emptyList())
        }
        return Frame(MirrorText.buildStatus(listOf("Notes", file)), buildNotesBody(ed))
    }

    private fun buildNotesBody(ed: EditorSnapshot): List<String> {
        val rows = MirrorText.BODY_ROWS
        val total = ed.lines.size
        val cursorLine = ed.cursorLine.coerceIn(1, total)
        val hasBelow = cursorLine < total
        val endLine = if (hasBelow) cursorLine + 1 else cursorLine
        val lnWidth = endLine.toString().length
        val prefixWidth = lnWidth + 1
        val textWidth = maxOf(10, MirrorText.DISPLAY_COLS - prefixWidth)
        val contPrefix = " ".repeat(prefixWidth)
        val cursorGlyph = "|"
        val sentinel = "\u0001" // CM6 CURSOR_SENTINEL parity

        fun renderLine(n: Int, withCursor: Boolean): List<String> {
            var text = ed.lines.getOrElse(n - 1) { "" }
            if (withCursor) {
                val col = ed.cursorCol.coerceIn(0, text.length)
                text = text.substring(0, col) + sentinel + text.substring(col)
            }
            val lnPrefix = n.toString().padStart(lnWidth, ' ') + " "
            return MirrorText.wrapLine(text, lnPrefix, contPrefix, contPrefix.length + textWidth)
        }

        val cursorLineRows = renderLine(cursorLine, withCursor = true).toMutableList()
        var cursorPhysOffset = 0
        for (i in cursorLineRows.indices) {
            if (cursorLineRows[i].contains(sentinel)) {
                cursorLineRows[i] = cursorLineRows[i].replace(sentinel, cursorGlyph)
                cursorPhysOffset = i
                break
            }
        }
        val cursorRow = cursorLineRows.getOrElse(cursorPhysOffset) { "" }

        var rowsAbove: MutableList<String> = cursorLineRows.subList(0, cursorPhysOffset).toMutableList()
        var n = cursorLine - 1
        while (rowsAbove.size < rows - 1 && n >= 1) {
            rowsAbove = (renderLine(n, withCursor = false) + rowsAbove).toMutableList()
            n -= 1
        }

        val belowRow = if (hasBelow) renderLine(cursorLine + 1, withCursor = false).firstOrNull() ?: "" else null

        return if (belowRow != null) {
            val above = rowsAbove.takeLast(rows - 2).toMutableList()
            while (above.size < rows - 2) above.add(0, "")
            above + cursorRow + belowRow
        } else {
            val above = rowsAbove.takeLast(rows - 1).toMutableList()
            while (above.size < rows - 1) above.add(0, "")
            above + cursorRow
        }
    }

    private fun basename(path: String): String {
        val slash = path.lastIndexOf('/')
        return if (slash >= 0) path.substring(slash + 1) else path
    }

    // --- small helpers --- //

    private fun parseField(payloadJson: String, vararg keys: String): String? {
        val obj = runCatching { json.parseToJsonElement(payloadJson).jsonObject }.getOrNull() ?: return null
        for (k in keys) obj[k]?.let { return runCatching { it.jsonPrimitive.content }.getOrNull() }
        return null
    }
}
