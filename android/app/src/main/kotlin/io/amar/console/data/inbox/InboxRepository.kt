package io.amar.console.data.inbox

import io.amar.console.core.HubClient
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.ItemSnoozeRow
import io.amar.console.data.db.MailThreadRow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock

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
    /** The hub's spaces list (SpacesRepository.spaces) — every agent-row join
     *  derives from it: review hand-backs, `#blocked` cards, owned-card
     *  headers, space titles. */
    spacesFlow: Flow<List<io.amar.console.data.spaces.SpacesRepository.SpaceSummary>> = MutableStateFlow(emptyList()),
) {
    private val rules = MutableStateFlow(InboxRules.DEFAULT)
    private val xOnly = MutableStateFlow(false)

    // Rules persistence (SPA ^spry-wren `console:inbox-rules` mirror): the hub
    // copy is authoritative; a Room meta row is the offline seed, written on
    // every successful GET/POST. A POST the hub missed leaves `dirtyRules`
    // set, and the next refresh PUSHES the local copy instead of pulling the
    // stale one over it (newest save wins via `saveSeq`).
    @Volatile private var dirtyRules = false
    private var saveSeq = 0L
    private val seedOnce = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var fetchedOnce = false
    // Seed and fetch-apply run under one lock: the boot-time seed (init) and an
    // Inbox-open refresh race, and a late seed must never overwrite a fresher
    // hub copy (flaked in the full suite before the lock).
    private val rulesLock = kotlinx.coroutines.sync.Mutex()
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
        combine(sessionsFlow, spacesFlow) { s, sp -> s to sp },
        db.feeds().observeSnoozes(),
        rules,
        combine(xOnly, nowTick) { x, _ -> x },
    ) { src, (sessions, spaces), snoozes, r, x ->
        val now = System.currentTimeMillis()
        composeInbox(
            threads = src.threads,
            rooms = src.rooms,
            feedItems = src.items,
            feedsById = src.feeds.associateBy { it.id },
            readIds = src.readIds.toHashSet(),
            snoozedKeys = snoozes.filter { it.snoozedUntil > now }.associate { it.key to it.snoozedUntil },
            sessions = sessions,
            rules = r,
            now = now,
            xOnly = x,
            spaces = spaces,
        )
    // WhileSubscribed(0) + catch, NOT Eagerly: an eager (or lingering) collector
    // observes Room past the screen's lifetime — under Robolectric (which boots
    // the REAL ConsoleApp, the ^brisk-moth lesson) that outlives AppLaunchTest's
    // deliberately-closed DB and throws into the NEXT test class. Stop promptly
    // on unsubscribe and contain a closed-DB throw (it can only happen at
    // shutdown/in tests; the inbox just stops updating).
    // The offline rules seed rides the FIRST subscription (onStart), never the
    // constructor: an init-time Room read is the eager-collection class that
    // reopens a closed DB under Robolectric (AppLaunchTest's stranded-DB case).
    }.onStart { runCatching { seedRulesFromMirror() } }
        .catch { }
        .stateIn(scope, SharingStarted.WhileSubscribed(0), InboxLists(emptyList(), emptyList()))

    /** Matrix `m.favourite` rooms, alphabetical — the Inbox's pinned-chats
     *  avatar strip (SPA `InboxPinnedChats`, ^shy-loon). List membership is
     *  unchanged: the strip is the reach-for-it surface, read or not. */
    val pinnedRooms: Flow<List<ChatRoomRow>> = db.chatRooms().observeAll()
        .map { rooms -> rooms.filter { it.isPinned }.sortedBy { it.name.lowercase() } }
        .catch { }

    init {
        scope.launch {
            while (true) {
                delay(5 * 60 * 1000L)
                nowTick.value = System.currentTimeMillis()
            }
        }
    }

    fun setXOnly(value: Boolean) { xOnly.value = value }

    /** Run a handling action on the repo's scope (screens have no own scope for fire-and-forget). */
    fun launch(block: suspend () -> Unit) { scope.launch { block() } }

    /** Seed the rules from the local mirror — composition never waits on the
     *  hub (a DOWN hub hangs the GET for the TCP timeout; the phone would show
     *  default routing meanwhile). Idempotent; runs before the first GET. */
    suspend fun seedRulesFromMirror() {
        if (!seedOnce.compareAndSet(false, true)) return
        val raw = runCatching { db.meta().get(RULES_META_KEY) }.getOrNull() ?: return
        rulesLock.withLock {
            // A live local edit or a landed hub fetch already replaced the seed.
            if (dirtyRules || fetchedOnce) return
            rules.value = InboxRules.fromJson(raw)
        }
    }

    /**
     * Reconcile with the hub: push the local copy when a save was dropped
     * (dirty), else pull. Offline keeps whatever we have — the mirror-seeded
     * rules, never DEFAULTS over a promoted/demoted source. Re-run on every
     * sync-WS (re)connect ([wireLive]) and on Inbox open.
     */
    suspend fun refreshRules() {
        seedRulesFromMirror()
        if (dirtyRules) { pushRules(rules.value, saveSeq); return }
        val fetched = runCatching { InboxRules.fromJson(hub.get("/inbox/rules")) }.getOrNull() ?: return
        rulesLock.withLock {
            if (dirtyRules) return // a save landed while the GET was in flight — it wins
            fetchedOnce = true
            rules.value = fetched
        }
        persistMirror(fetched)
    }

    /** Re-pull on every (re)connect so a promote on the desktop reaches the
     *  phone without an Inbox re-open, and a dropped save gets pushed. */
    fun wireLive(syncBus: io.amar.console.sync.SyncBusClient) {
        syncBus.onConnect { scope.launch { runCatching { refreshRules() } } }
    }

    private suspend fun persistMirror(r: InboxRules) {
        runCatching { db.meta().put(io.amar.console.data.db.MetaRow(RULES_META_KEY, r.toJson())) }
    }

    private fun saveRules(next: InboxRules) {
        rules.value = next
        val seq = ++saveSeq
        dirtyRules = true
        scope.launch {
            persistMirror(next)
            pushRules(next, seq)
        }
    }

    private suspend fun pushRules(r: InboxRules, seq: Long) {
        val ok = runCatching { hub.post("/inbox/rules", r.toJson()) }.isSuccess
        // Only a push of the NEWEST save clears the flag; an older in-flight
        // save landing later must not mark a newer local edit as synced.
        if (ok && seq == saveSeq) dirtyRules = false
    }

    /** Promote/demote an entry's source; optimistic, then hub-persisted. */
    fun toggleRoute(entry: InboxEntry) {
        val next = toggledRules(rules.value, entry) ?: return
        saveRules(next)
    }

    /** Every persisted override, labelled from the local room/feed tables
     *  (an override can name a room that's no longer in the inbox lists). */
    val overrides: Flow<List<RouteOverride>> = combine(
        rules,
        db.chatRooms().observeAll(),
        db.feeds().observeFeeds(),
    ) { r, rooms, feeds ->
        listOverrides(r, rooms.associate { it.id to it.name }, feeds.associate { it.id to it.title })
    }.catch { }

    /** Remove one override (the ✕ in the routing-rules sheet); optimistic, then hub-persisted. */
    fun clearOverride(source: InboxSource, key: String) {
        val next = withoutOverride(rules.value, source, key)
        if (next == rules.value) return
        saveRules(next)
    }

    /** Test seam: current dirty state (a dropped save awaiting the next connect). */
    internal fun rulesDirty(): Boolean = dirtyRules
    internal fun currentRules(): InboxRules = rules.value

    companion object {
        const val RULES_META_KEY = "inbox:rules"
    }

    /** Snooze a feed item or agent session by Inbox key — local-only (SPA
     *  `itemSnooze` parity; mail/chat snooze through their own repositories). */
    fun snoozeItem(key: String, untilMs: Long) {
        scope.launch { db.feeds().upsertSnooze(ItemSnoozeRow(key, untilMs)); nowTick.value = System.currentTimeMillis() }
    }

    fun unsnoozeItem(key: String) {
        scope.launch { db.feeds().deleteSnooze(key); nowTick.value = System.currentTimeMillis() }
    }
}
