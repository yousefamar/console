package io.amar.console.data.inbox

import io.amar.console.core.HubClient
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.FeedSnoozeRow
import io.amar.console.data.db.MailThreadRow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Unified Inbox — composition over the existing per-source Room tables.
 * Owns NO source data (the mail/chat/feeds/agents repos keep syncing their
 * own worlds); this only routes + orders, so an item handled here or in its
 * own app drops out identically. Rules live hub-side at /inbox/rules
 * (shared with the SPA — a promote on the phone routes the source on the
 * desktop too).
 *
 * Time-sensitive membership (snooze expiry, SLA overdue) is filtered at
 * COMPOSE time against a live clock; DAO queries deliberately carry no `now`
 * (a bound `:now` freezes at construction — rows would stay hidden/shown
 * until app restart). A 5-min tick re-composes so lines crossed with no DB
 * event firing (overdue-ness, expiring snoozes) still surface.
 */
class InboxRepository(
    private val scope: CoroutineScope,
    private val db: ConsoleDb,
    private val hub: HubClient,
    /** Agent sessions ride the agents WS — injected so composition
     *  recomputes on session changes. */
    sessionsFlow: Flow<List<AgentSessionRow>>,
) {
    private val rules = MutableStateFlow(InboxRules.DEFAULT)
    private val xOnly = MutableStateFlow(false)
    val xOnlyMode: StateFlow<Boolean> = xOnly

    /** Bumped every 5 min + after local mutations — a compose input, so
     *  changing it genuinely recomputes (it feeds the combine, not a tap). */
    private val nowTick = MutableStateFlow(System.currentTimeMillis())

    private data class Sources(
        val threads: List<MailThreadRow>,
        val rooms: List<ChatRoomRow>,
        val items: List<FeedItemRow>,
        val feeds: List<FeedRow>,
        val readIds: List<String>,
    )

    private val sources: Flow<Sources> = combine(
        // Long.MAX_VALUE = include currently-snoozed threads; threadIsLive
        // re-filters with a live clock so expiry needs no re-query.
        db.mailThreads().observeInbox(Long.MAX_VALUE),
        db.chatRooms().observeAll(),
        db.feeds().observeRecent(300),
        db.feeds().observeFeeds(),
        db.feeds().observeReadIds(),
    ) { threads, rooms, items, feeds, readIds -> Sources(threads, rooms, items, feeds, readIds) }

    val lists: StateFlow<InboxLists> = combine(
        sources,
        sessionsFlow,
        db.feeds().observeSnoozes(),
        rules,
        combine(xOnly, nowTick) { x, _ -> x },
    ) { src, sessions, snoozes, r, x ->
        val now = System.currentTimeMillis()
        composeInbox(
            threads = src.threads,
            rooms = src.rooms,
            feedItems = src.items,
            feedsById = src.feeds.associateBy { it.id },
            readIds = src.readIds.toHashSet(),
            snoozedFeedIds = snoozes.filter { it.snoozedUntil > now }.map { it.itemId }.toHashSet(),
            sessions = sessions,
            rules = r,
            now = now,
            xOnly = x,
        )
    // WhileSubscribed(0) + catch, NOT Eagerly: an eager (or lingering) collector
    // observes Room past the screen's lifetime — under Robolectric (which boots
    // the REAL ConsoleApp, the ^brisk-moth lesson) that outlives AppLaunchTest's
    // deliberately-closed DB and throws into the NEXT test class. Stop promptly
    // on unsubscribe and contain a closed-DB throw (it can only happen at
    // shutdown/in tests; the inbox just stops updating).
    }.catch { }
        .stateIn(scope, SharingStarted.WhileSubscribed(0), InboxLists(emptyList(), emptyList()))

    init {
        scope.launch {
            while (true) {
                delay(5 * 60 * 1000L)
                nowTick.value = System.currentTimeMillis()
            }
        }
    }

    fun setXOnly(value: Boolean) { xOnly.value = value }

    /** Load hub rules; offline keeps whatever we have (defaults at boot). */
    suspend fun refreshRules() {
        runCatching { rules.value = InboxRules.fromJson(hub.get("/inbox/rules")) }
    }

    /** Promote/demote an entry's source; optimistic, then hub-persisted. */
    fun toggleRoute(entry: InboxEntry) {
        val next = toggledRules(rules.value, entry) ?: return
        rules.value = next
        scope.launch { runCatching { hub.post("/inbox/rules", next.toJson()) } }
    }

    /** Snooze a feed item — local-only (SPA feedSnooze parity). */
    fun snoozeFeedItem(itemId: String, untilMs: Long) {
        scope.launch { db.feeds().upsertSnooze(FeedSnoozeRow(itemId, untilMs)) }
    }
}
