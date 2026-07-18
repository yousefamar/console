package io.amar.console.glasses.mirror

import android.content.Context
import android.content.SharedPreferences
import io.amar.console.core.AppLifecycle
import io.amar.console.data.db.ConsoleDb
import io.amar.console.glasses.GlassesController
import io.amar.console.glasses.mirror.MirrorText.Frame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Native port of the SPA's app-wide glasses mirror (src/glasses/mirror.ts):
 * renders whatever pane/route the user is on to the G1 lenses, 5×40.
 *
 * Trigger points: route changes (AppShell feeds currentRoute), composer
 * keystrokes (screens push via [setComposerText]), and Room Flows would be
 * overkill — the mirror re-renders on a 30ms coalescing tick whenever
 * poked, reading the CURRENT state from the DAOs.
 *
 * The keystroke → BLE path never touches the hub (≤100ms), same as the SPA.
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

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _enabled = MutableStateFlow(prefs.getBoolean(KEY_ENABLED, false))
    val enabledFlow: StateFlow<Boolean> = _enabled
    val enabled: Boolean get() = _enabled.value

    /** Per-pane composer echo (chat/agents screens push keystrokes here). */
    @Volatile private var composerText: String = ""
    @Volatile private var lastSentPayload: String = ""
    private var pending: Job? = null
    /** Set by MainActivity so the mirror can drive the stealth-dim window. */
    var applyDim: ((Boolean) -> Unit)? = null

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
    }

    fun setComposerText(text: String) {
        composerText = text
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
    // Per-route renderers (ports of src/glasses/panes/*.ts against Room)

    internal suspend fun renderRoute(route: String): Frame? = when {
        route.startsWith("chat/") -> renderChatRoom(route.removePrefix("chat/"))
        route == "chat" -> renderChatList()
        route.startsWith("mail") -> renderMail()
        route.startsWith("calendar") -> renderCalendar()
        route.startsWith("agents/") -> renderAgentSession(route.removePrefix("agents/"))
        route.startsWith("agents") -> renderAgentsList()
        route.startsWith("feeds") -> renderFeeds()
        route.startsWith("notes") -> renderNotesRoute(route)
        else -> Frame(MirrorText.buildStatus(listOf("Console", route)), emptyList())
    }

    private suspend fun renderChatRoom(roomId: String): Frame {
        val room = db.chatRooms().byId(roomId)
        val messages = db.chatMessages().recent(roomId, 12)
            .filter { !it.isDeleted }
            .take(3)
            .reversed()
        val body = messages.map { m ->
            val who = MirrorText.shortName(m.senderName ?: m.senderId)
            val text = if (m.msgtype == "m.image") "[image]" else (m.body ?: "")
            MirrorText.clipRow("$who: $text")
        } + MirrorText.composerRow(composerText)
        return Frame(
            MirrorText.buildStatus(listOf("Chat", room?.name ?: roomId, room?.unreadCount?.takeIf { it > 0 }?.let { "${it}u" })),
            body,
        )
    }

    private suspend fun renderChatList(): Frame {
        val rooms = db.chatRooms().allIds().size
        return Frame(MirrorText.buildStatus(listOf("Chat", "$rooms rooms")), emptyList())
    }

    private suspend fun renderMail(): Frame {
        val inbox = db.mailThreads().inboxIds()
        return Frame(MirrorText.buildStatus(listOf("Mail", "${inbox.size} in inbox")), emptyList())
    }

    private suspend fun renderCalendar(): Frame {
        val now = System.currentTimeMillis()
        val today = db.calendar().keysInRange(now, now + 24 * 3600_000L)
        return Frame(MirrorText.buildStatus(listOf("Calendar", "${today.size} upcoming 24h")), emptyList())
    }

    private suspend fun renderAgentSession(sessionId: String): Frame {
        val session = db.agents().byId(sessionId)
        val recent = db.agents().recent(sessionId, 12)
            .filter { it.kind == "text" || it.kind == "user_prompt" }
            .take(3)
            .reversed()
            .map { row ->
                val obj = runCatching {
                    kotlinx.serialization.json.Json.parseToJsonElement(row.payloadJson)
                        as? kotlinx.serialization.json.JsonObject
                }.getOrNull()
                val content = (obj?.get("content") ?: obj?.get("text"))
                    ?.let { runCatching { (it as kotlinx.serialization.json.JsonPrimitive).content }.getOrNull() }
                    ?: ""
                val prefix = if (row.kind == "user_prompt") "you: " else ""
                MirrorText.clipRow("$prefix$content")
            }
        val body = recent + MirrorText.composerRow(composerText)
        return Frame(
            MirrorText.buildStatus(listOf("Agents", session?.name ?: sessionId, session?.status)),
            body,
        )
    }

    private suspend fun renderAgentsList(): Frame {
        return Frame(MirrorText.buildStatus(listOf("Agents")), emptyList())
    }

    private suspend fun renderFeeds(): Frame {
        return Frame(MirrorText.buildStatus(listOf("Feeds")), emptyList())
    }

    private suspend fun renderNotesRoute(route: String): Frame {
        val time = SimpleDateFormat("HH:mm", Locale.UK).format(Date())
        return Frame(MirrorText.buildStatus(listOf("Notes", time)), emptyList())
    }
}
