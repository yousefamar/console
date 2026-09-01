package io.amar.console.data.inbox

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.MailThreadRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Unified Inbox — pure logic, port of the SPA's src/inbox/route.ts +
 * src/inbox/types.ts. No Android deps so plain-JUnit testable.
 *
 * The pane composes four sources (mail threads, chat rooms, feed items,
 * agent sessions) into two lists: "feed" (casual browse) and "inbox"
 * (inbox-zero: everything here gets handled). Membership is DERIVED from
 * each source's existing semantics — no new read/done state anywhere, so an
 * item handled here or in its own app drops out identically.
 */

private val inboxJson = Json { ignoreUnknownKeys = true }

// --------------------------------------------------------------------------
// Routing rules (hub-persisted at /inbox/rules — same JSON shape as the SPA:
// {chat:{default,rooms},mail:{default,senders},feeds:{default,feeds},
//  sla:{dmHours,rooms}}). Routes are strings for wire fidelity:
// 'feed' | 'inbox' (+ 'hidden' for feeds only).
// --------------------------------------------------------------------------

data class InboxRules(
    val chatDefault: String = "inbox",
    val chatRooms: Map<String, String> = emptyMap(),
    val mailDefault: String = "inbox",
    val mailSenders: Map<String, String> = emptyMap(),
    val feedsDefault: String = "feed",
    val feedFeeds: Map<String, String> = emptyMap(),
    val slaDmHours: Double = 24.0,
    val slaRooms: Map<String, Double> = emptyMap(),
) {
    companion object {
        val DEFAULT = InboxRules()

        /** Tolerant parse of a (possibly partial) rules JSON — missing
         *  branches fall back to defaults, mirroring the SPA normalizeRules. */
        fun fromJson(raw: String?): InboxRules {
            if (raw.isNullOrBlank()) return DEFAULT
            val o = runCatching { inboxJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return DEFAULT
            fun routes(section: String, mapKey: String): Pair<String?, Map<String, String>> {
                val s = o[section] as? JsonObject ?: return null to emptyMap()
                val map = (s[mapKey] as? JsonObject)?.entries
                    ?.mapNotNull { (k, v) -> v.jsonPrimitive.content.let { k to it } }?.toMap()
                return s["default"]?.jsonPrimitive?.content to (map ?: emptyMap())
            }
            val (chatDef, chatRooms) = routes("chat", "rooms")
            val (mailDef, mailSenders) = routes("mail", "senders")
            val (feedsDef, feedFeeds) = routes("feeds", "feeds")
            val sla = o["sla"] as? JsonObject
            val slaRooms = (sla?.get("rooms") as? JsonObject)?.entries
                ?.mapNotNull { (k, v) -> v.jsonPrimitive.doubleOrNull?.let { k to it } }?.toMap()
            return InboxRules(
                chatDefault = chatDef ?: DEFAULT.chatDefault,
                chatRooms = chatRooms,
                mailDefault = mailDef ?: DEFAULT.mailDefault,
                mailSenders = mailSenders,
                feedsDefault = feedsDef ?: DEFAULT.feedsDefault,
                feedFeeds = feedFeeds,
                slaDmHours = sla?.get("dmHours")?.jsonPrimitive?.doubleOrNull ?: DEFAULT.slaDmHours,
                slaRooms = slaRooms ?: emptyMap(),
            )
        }
    }

    /** Serialize back to the SPA's wire shape (POST /inbox/rules body). */
    fun toJson(): String = buildJsonObject {
        putJsonObject("chat") {
            put("default", chatDefault)
            putJsonObject("rooms") { chatRooms.forEach { (k, v) -> put(k, v) } }
        }
        putJsonObject("mail") {
            put("default", mailDefault)
            putJsonObject("senders") { mailSenders.forEach { (k, v) -> put(k, v) } }
        }
        putJsonObject("feeds") {
            put("default", feedsDefault)
            putJsonObject("feeds") { feedFeeds.forEach { (k, v) -> put(k, v) } }
        }
        putJsonObject("sla") {
            put("dmHours", slaDmHours)
            putJsonObject("rooms") { slaRooms.forEach { (k, v) -> put(k, v) } }
        }
    }.toString()

    fun routeForRoom(roomId: String): String = chatRooms[roomId] ?: chatDefault
    fun routeForSender(email: String?): String = mailSenders[email?.lowercase() ?: ""] ?: mailDefault
    fun routeForFeed(feedId: String): String = feedFeeds[feedId] ?: feedsDefault
}

// --------------------------------------------------------------------------
// Item model.
// --------------------------------------------------------------------------

enum class InboxSource { MAIL, CHAT, FEED, AGENT }

data class InboxEntry(
    /** `${source}:${sourceId}` — unique across sources. */
    val key: String,
    val source: InboxSource,
    val sourceId: String,
    /** Row header: the person (DM/mail sender), group name, or feed title. */
    val header: String,
    /** Row body: message text, mail subject, or feed-item title. */
    val body: String,
    /** Chat bridge network (whatsapp/slack/…) — drives the channel icon. */
    val network: String? = null,
    val ts: Long,
    /** true → inbox list, false → feed list. */
    val inInbox: Boolean,
    /** Agent only: session flagged @amar / pending question — tops the inbox. */
    val attention: Boolean = false,
    /** Chat only: DM unanswered past its SLA window — tops the inbox. */
    val overdue: Boolean = false,
    /** The rules-override key this item's SOURCE routes by (room id / sender
     *  email / feed id) — what promote/demote writes. Null for agents. */
    val routeKey: String? = null,
    /** Feed only: the feed lives in a hidden FOLDER (X) — suppressed from the
     *  Feed list by default, shown exclusively in X-only mode. */
    val hiddenFolder: Boolean = false,
)

/** Folders whose feeds never appear in the Feed list by default — port of
 *  src/feeds/hidden-folders.ts (keep the sets in sync). */
private val HIDDEN_FOLDERS = setOf("x")

fun isHiddenFolder(folder: String?): Boolean =
    folder != null && folder.lowercase() in HIDDEN_FOLDERS

// --------------------------------------------------------------------------
// SLA — "DM unanswered past its window". Timestamps ride the room's rawJson
// (the verbatim hub RoomState), so no chat schema change is needed.
// --------------------------------------------------------------------------

data class SlaTimestamps(val lastInboundTs: Long, val lastOutboundTs: Long)

fun slaTimestamps(rawJson: String?): SlaTimestamps {
    if (rawJson.isNullOrBlank()) return SlaTimestamps(0, 0)
    val o = runCatching { inboxJson.parseToJsonElement(rawJson).jsonObject }.getOrNull()
        ?: return SlaTimestamps(0, 0)
    return SlaTimestamps(
        lastInboundTs = o["lastInboundTs"]?.jsonPrimitive?.longOrNull ?: 0,
        lastOutboundTs = o["lastOutboundTs"]?.jsonPrimitive?.longOrNull ?: 0,
    )
}

/** DM unanswered past its SLA window: the other side spoke after my last
 *  reply, and that inbound has aged past the window. Groups have no default
 *  SLA (a per-room override can add one); window 0 disables. */
fun isOverdue(room: ChatRoomRow, rules: InboxRules, now: Long): Boolean {
    val hours = rules.slaRooms[room.id] ?: (if (room.isDirect) rules.slaDmHours else 0.0)
    if (hours <= 0.0) return false
    val (inbound, outbound) = slaTimestamps(room.rawJson)
    if (inbound == 0L) return false
    if (outbound >= inbound) return false
    return now - inbound > (hours * 3_600_000).toLong()
}

// --------------------------------------------------------------------------
// Membership predicates — one place per source, mirroring source semantics.
// --------------------------------------------------------------------------

fun threadIsLive(t: MailThreadRow, now: Long): Boolean =
    t.isInbox && (t.snoozedUntil == null || t.snoozedUntil <= now)

fun roomIsLive(r: ChatRoomRow, rules: InboxRules, now: Long): Boolean {
    if (r.snoozedUntil != null && r.snoozedUntil > now) return false
    if (r.isLowPriority || r.isMuted) return false
    // An overdue DM is typically READ but unanswered — it re-enters the inbox
    // despite being read. Replying clears it (lastOutboundTs advances).
    if (isOverdue(r, rules, now)) return true
    return r.isUnread || r.manualUnread
}

/** Unread agent sessions demand handling; Al is a standing conversation, not
 *  an item to clear. */
fun sessionIsLive(s: AgentSessionRow): Boolean =
    !s.isAl && (s.hasUnread || s.needsAttention)

// --------------------------------------------------------------------------
// Adapters: source rows → InboxEntry.
// --------------------------------------------------------------------------

fun threadToEntry(t: MailThreadRow, rules: InboxRules): InboxEntry = InboxEntry(
    key = "mail:${t.id}",
    source = InboxSource.MAIL,
    sourceId = t.id,
    header = t.fromName.ifBlank { t.fromEmail },
    body = t.subject.ifBlank { "(no subject)" },
    ts = t.date,
    inInbox = rules.routeForSender(t.fromEmail) == "inbox",
    routeKey = t.fromEmail.lowercase(),
)

fun roomToEntry(r: ChatRoomRow, rules: InboxRules, now: Long): InboxEntry {
    val sender = r.lastMessageSender
    val text = r.lastMessageBody ?: ""
    // DMs drop the sender prefix when the sender IS the room's namesake —
    // their name is already the header (SPA roomToItem parity).
    val body = if (sender.isNullOrBlank() || (r.isDirect && sender == r.name)) text else "$sender: $text"
    return InboxEntry(
        key = "chat:${r.id}",
        source = InboxSource.CHAT,
        sourceId = r.id,
        header = r.name,
        body = body,
        network = r.networkIcon,
        ts = r.lastMessageTime,
        inInbox = rules.routeForRoom(r.id) == "inbox",
        overdue = isOverdue(r, rules, now),
        routeKey = r.id,
    )
}

/** Agents are inbox-shaped by definition — no routing rules apply. */
fun sessionToEntry(s: AgentSessionRow): InboxEntry = InboxEntry(
    key = "agent:${s.id}",
    source = InboxSource.AGENT,
    sourceId = s.id,
    header = s.name.removeSuffix(" (fork)"),
    body = s.attentionSnippet ?: s.lastTextSnippet ?: "",
    ts = if (s.lastActivityAt > 0) s.lastActivityAt else s.createdAt,
    inInbox = true,
    attention = s.needsAttention,
)

/** Null when the feed is routed 'hidden' — dropped from the pane entirely. */
fun feedItemToEntry(i: FeedItemRow, feed: FeedRow?, rules: InboxRules): InboxEntry? {
    val route = rules.routeForFeed(i.feedId)
    if (route == "hidden") return null
    return InboxEntry(
        key = "feed:${i.id}",
        source = InboxSource.FEED,
        sourceId = i.id,
        header = feed?.title ?: "",
        body = i.title,
        ts = i.publishedAt,
        inInbox = route == "inbox",
        routeKey = i.feedId,
        hiddenFolder = isHiddenFolder(feed?.folder),
    )
}

// --------------------------------------------------------------------------
// Ordering — the SPA's bands: overdue → attention-agents → chat+mail merged
// by recency (fresh mail must not sink under stale group unreads) →
// plain-unread agents → inbox-routed feed items. Recency within each band.
// --------------------------------------------------------------------------

private fun band(e: InboxEntry): Int = when {
    e.overdue -> 0
    e.source == InboxSource.AGENT -> if (e.attention) 1 else 3
    e.source == InboxSource.CHAT || e.source == InboxSource.MAIL -> 2
    else -> 4
}

fun sortInbox(entries: List<InboxEntry>): List<InboxEntry> =
    entries.sortedWith(compareBy({ band(it) }, { -it.ts }))

fun sortFeed(entries: List<InboxEntry>): List<InboxEntry> =
    entries.sortedByDescending { it.ts }

/** Feed-list display mode: hidden-folder items (X posts) are suppressed by
 *  default and shown EXCLUSIVELY in X-only mode. Feed list only — an item
 *  explicitly routed to inbox was a deliberate override. */
fun filterByFeedMode(entries: List<InboxEntry>, xOnly: Boolean): List<InboxEntry> =
    entries.filter { if (xOnly) it.hiddenFolder else !it.hiddenFolder }

// --------------------------------------------------------------------------
// Whole-pane composition — one pure function from source rows to both lists.
// --------------------------------------------------------------------------

data class InboxLists(val feed: List<InboxEntry>, val inbox: List<InboxEntry>)

fun composeInbox(
    threads: List<MailThreadRow>,
    rooms: List<ChatRoomRow>,
    feedItems: List<FeedItemRow>,
    feedsById: Map<String, FeedRow>,
    readIds: Set<String>,
    snoozedFeedIds: Set<String>,
    sessions: List<AgentSessionRow>,
    rules: InboxRules,
    now: Long,
    xOnly: Boolean = false,
): InboxLists {
    val all = buildList {
        threads.filter { threadIsLive(it, now) }.forEach { add(threadToEntry(it, rules)) }
        rooms.filter { roomIsLive(it, rules, now) }.forEach { add(roomToEntry(it, rules, now)) }
        feedItems.asSequence()
            .filter { it.id !in readIds && it.id !in snoozedFeedIds }
            .mapNotNull { feedItemToEntry(it, feedsById[it.feedId], rules) }
            .forEach { add(it) }
        sessions.filter { sessionIsLive(it) }.forEach { add(sessionToEntry(it)) }
    }
    return InboxLists(
        feed = sortFeed(filterByFeedMode(all.filter { !it.inInbox }, xOnly)),
        inbox = sortInbox(all.filter { it.inInbox }),
    )
}

/** Toggled rules after promoting/demoting an entry's SOURCE — a judgment
 *  about the source, not the one item. Null when the entry doesn't route
 *  (agents). Mirrors the SPA toggleRoute: an override matching the default
 *  is removed rather than stored. */
fun toggledRules(rules: InboxRules, entry: InboxEntry): InboxRules? {
    val key = entry.routeKey ?: return null
    val target = if (entry.inInbox) "feed" else "inbox"
    fun apply(map: Map<String, String>, default: String): Map<String, String> =
        if (target == default) map - key else map + (key to target)
    return when (entry.source) {
        InboxSource.CHAT -> rules.copy(chatRooms = apply(rules.chatRooms, rules.chatDefault))
        InboxSource.MAIL -> rules.copy(mailSenders = apply(rules.mailSenders, rules.mailDefault))
        InboxSource.FEED -> rules.copy(feedFeeds = apply(rules.feedFeeds, rules.feedsDefault))
        InboxSource.AGENT -> null
    }
}
