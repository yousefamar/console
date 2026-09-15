package io.amar.console.data.inbox

import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.ChatRoomRow
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.db.MailThreadRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
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
    /** Row header: the person (DM/mail sender), group name, article title, or
     *  — for a card-owned agent — its card text. */
    val header: String,
    /** Row body: message text, mail subject, or feed name. */
    val body: String,
    /** Agent only: the session's SPACE (project title, else first area) —
     *  rendered as a muted prefix before the header ("Console › Rosy owl"). */
    val context: String? = null,
    /** Agent only: the session's own name when [header] is its card text. */
    val agentName: String? = null,
    /** Chat bridge network (whatsapp/slack/…) — drives the channel icon. */
    val network: String? = null,
    val ts: Long,
    /** true → inbox list, false → feed list. */
    val inInbox: Boolean,
    /** Agent only: session flagged @amar / pending question — tops the inbox. */
    val attention: Boolean = false,
    /** Agent only: the turn has ended (not mid-stream) — a finished agent
     *  outranks one still typing. */
    val idle: Boolean = false,
    /** Agent only: its `@key` owns an Under Review card — a hand-back waiting
     *  on Yousef, banded beside attention. */
    val review: Boolean = false,
    /** Agent only: its `@key` owns a `#blocked` in-progress card — stuck on
     *  Yousef, banded with attention. Colours an admitted (idle + unread) row
     *  red; never admits a running session. */
    val blocked: Boolean = false,
    /** Chat only: DM unanswered past its SLA window — tops the inbox. */
    val overdue: Boolean = false,
    /** Chat only: the room holds an unsent draft (`body` is the draft text). */
    val draft: Boolean = false,
    /** The rules-override key this item's SOURCE routes by (room id / sender
     *  email / feed id) — what promote/demote writes. Null for agents. */
    val routeKey: String? = null,
    /** Feed only: the feed lives in a hidden FOLDER (X) — suppressed from the
     *  Feed list by default, shown exclusively in X-only mode. */
    val hiddenFolder: Boolean = false,
    /** Agent only: the session's `@key` — joins the row to its review cards. */
    val agentKey: String? = null,
    /** Set only in the snoozed view: when the item comes back. */
    val snoozedUntil: Long? = null,
    /** Feed only: platform of the subscription (chips + row glyph). */
    val feedKind: FeedKind? = null,
    /** Feed only: the feed's own icon URL (plain-RSS row glyph). */
    val icon: String? = null,
    /** Feed only: the item's thumbnail URL. */
    val image: String? = null,
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

/** The room's unsent draft (hub `RoomState.draft`, set from the SPA composer
 *  or `con chat draft`). Rides rawJson like the SLA timestamps — no schema
 *  change. Null when absent/blank. */
fun roomDraft(rawJson: String?): String? {
    if (rawJson.isNullOrBlank()) return null
    val o = runCatching { inboxJson.parseToJsonElement(rawJson).jsonObject }.getOrNull() ?: return null
    return o["draft"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
}

fun roomDraftUpdatedAt(rawJson: String?): Long {
    if (rawJson.isNullOrBlank()) return 0
    val o = runCatching { inboxJson.parseToJsonElement(rawJson).jsonObject }.getOrNull() ?: return 0
    return o["draftUpdatedAt"]?.jsonPrimitive?.longOrNull ?: 0
}

/** UNREAD DM unanswered past its SLA window: the other side spoke after my
 *  last reply, and that inbound has aged past the window. Overdue is an
 *  escalation of an unread thread, never a re-admission of a read one —
 *  read means "seen, decided not to reply" (Yousef, ^neat-bass). Groups have
 *  no default SLA (a per-room override can add one); window 0 disables. */
fun isOverdue(room: ChatRoomRow, rules: InboxRules, now: Long): Boolean {
    if (!room.isUnread && !room.manualUnread) return false
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

fun roomIsLive(r: ChatRoomRow, now: Long): Boolean {
    if (r.snoozedUntil != null && r.snoozedUntil > now) return false
    // An unsent draft is an obligation like an unread message — muted /
    // low-priority don't hide it (SPA roomIsLive parity).
    if (roomDraft(r.rawJson) != null) return true
    if (r.isLowPriority || r.isMuted) return false
    return r.isUnread || r.manualUnread
}

/** Agent sessions that demand handling are inbox-shaped by definition. A
 *  RUNNING session is not one of them: its unread text is a turn still being
 *  typed (^neat-fawn: "Inbox is only for things that require my attention").
 *  The ONE exception is `needsAttention` — a question/approval can block a
 *  still-running turn. A `#blocked` card never admits a running session. Al
 *  is a standing conversation, not an item to clear. */
fun sessionIsLive(s: AgentSessionRow): Boolean {
    if (s.isAl) return false
    if (s.needsAttention) return true
    if (!s.hasUnread) return false
    return s.status != "running"
}

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
    // A draft IS what needs handling — it replaces the last-message preview.
    val draft = roomDraft(r.rawJson)
    return InboxEntry(
        key = "chat:${r.id}",
        source = InboxSource.CHAT,
        sourceId = r.id,
        header = r.name,
        body = draft ?: body,
        network = r.networkIcon,
        ts = if (draft != null) maxOf(r.lastMessageTime, roomDraftUpdatedAt(r.rawJson)) else r.lastMessageTime,
        inInbox = rules.routeForRoom(r.id) == "inbox",
        overdue = isOverdue(r, rules, now),
        draft = draft != null,
        routeKey = r.id,
    )
}

/** Which space a session belongs to, for display: its project, else its
 *  first area, else nothing (chat forks / one-off creates). [titleOf] maps a
 *  slug to the space's title; an unknown slug falls back to the slug (SPA
 *  `sessionContext`). */
fun sessionContext(project: String?, areasCsv: String?, titleOf: (String) -> String? = { null }): String? {
    val slug = project ?: areasCsv?.split(',')?.firstOrNull { it.isNotBlank() }?.trim()
    if (slug.isNullOrBlank()) return null
    return titleOf(slug) ?: slug
}

/** Agents are inbox-shaped by definition — no routing rules apply.
 *  `reviewKeys` = every `@key` owning an Under Review card across all boards
 *  (SpaceSummary.reviewAgentKeys, flattened) — the session's card being in
 *  review is what makes it a hand-back. `blockedKeys` = every `@key` owning a
 *  `#blocked` in-progress card (stuck on Yousef — coloured like an @amar
 *  alert once admitted). `cardTextOf` = the card a card-owned session is
 *  ABOUT: it becomes the header and the fork's minted name drops to
 *  [InboxEntry.agentName] (a name like "Glad finch" says nothing). */
fun sessionToEntry(
    s: AgentSessionRow,
    reviewKeys: Set<String> = emptySet(),
    titleOf: (String) -> String? = { null },
    blockedKeys: Set<String> = emptySet(),
    cardTextOf: (String) -> String? = { null },
): InboxEntry {
    val idle = s.status != "running"
    val name = s.name.removeSuffix(" (fork)")
    val card = s.agentKey?.let(cardTextOf)
    return InboxEntry(
        key = "agent:${s.id}",
        source = InboxSource.AGENT,
        sourceId = s.id,
        header = card ?: name,
        agentName = if (card != null) name else null,
        context = sessionContext(s.project, s.areasCsv, titleOf),
        body = s.attentionSnippet ?: s.lastTextSnippet ?: "",
        ts = if (s.lastActivityAt > 0) s.lastActivityAt else s.createdAt,
        inInbox = true,
        attention = s.needsAttention,
        idle = idle,
        review = idle && s.agentKey != null && s.agentKey in reviewKeys,
        blocked = s.agentKey != null && s.agentKey in blockedKeys,
        agentKey = s.agentKey,
    )
}

/**
 * Review cards an agent row can approve from the Inbox — port of
 * `reviewHandbacksFor` in src/inbox/route.ts. NOT gated on idle (unlike the
 * ordering tier): a card in Under Review is approvable whatever the session
 * is doing. `query` addresses the card for the hub's move verb.
 */
fun reviewHandbacksFor(
    agentKey: String?,
    spaces: List<io.amar.console.data.spaces.SpacesRepository.SpaceSummary>,
): List<io.amar.console.data.spaces.SpacesRepository.ReviewHandback> {
    if (agentKey == null) return emptyList()
    val out = ArrayList<io.amar.console.data.spaces.SpacesRepository.ReviewHandback>()
    for (s in spaces) {
        if (s.kind != "project") continue
        for (c in s.reviewCards) {
            if (c.agentKey != agentKey) continue
            out += io.amar.console.data.spaces.SpacesRepository.ReviewHandback(
                project = s.slug,
                query = c.blockId?.let { "^$it" } ?: c.text,
                text = c.text,
                doneColumn = s.doneColumn,
            )
        }
    }
    return out
}

/** A `#blocked` in-progress card this agent owns — what the unblock strip
 *  needs to address it on `/board/:project/block` (SPA `BlockedCard`). */
data class BlockedCard(val project: String, val query: String, val text: String)

/** `#blocked` in-progress cards owned by [agentKey] across every project
 *  board (SPA `blockedCardsFor`). */
fun blockedCardsFor(
    agentKey: String?,
    spaces: List<io.amar.console.data.spaces.SpacesRepository.SpaceSummary>,
): List<BlockedCard> {
    if (agentKey == null) return emptyList()
    val out = ArrayList<BlockedCard>()
    for (s in spaces) {
        if (s.kind != "project") continue
        for (c in s.blockedCards) {
            if (c.agentKey != agentKey) continue
            out += BlockedCard(project = s.slug, query = c.blockId?.let { "^$it" } ?: c.text, text = c.text)
        }
    }
    return out
}

/** Every `@key` owning a `#blocked` in-progress card, across all boards —
 *  derived from board state, so it survives hub restarts (the hub's
 *  transition-time attention flag does not). */
fun blockedAgentKeys(spaces: List<io.amar.console.data.spaces.SpacesRepository.SpaceSummary>): Set<String> =
    spaces.flatMapTo(HashSet()) { it.blockedAgentKeys }

/** The card an agent's Inbox row is ABOUT: a #blocked one first (the row is
 *  banded for it), then its Under Review hand-back, then whatever it is
 *  working in In Progress. Null when its `@key` owns no live card (SPA
 *  `ownedCardText`). */
fun ownedCardText(
    agentKey: String?,
    spaces: List<io.amar.console.data.spaces.SpacesRepository.SpaceSummary>,
): String? {
    if (agentKey == null) return null
    blockedCardsFor(agentKey, spaces).firstOrNull()?.let { return it.text }
    reviewHandbacksFor(agentKey, spaces).firstOrNull()?.let { return it.text }
    for (s in spaces) {
        if (s.kind != "project") continue
        s.ownedCards.firstOrNull { it.agentKey == agentKey }?.let { return it.text }
    }
    return null
}

/** Null when the feed is routed 'hidden' — dropped from the pane entirely.
 *  Feeds invert the who/what shape: the ARTICLE title is what Yousef scans
 *  for, the feed name is context — the platform glyph + favicon on the row
 *  already say where it came from (^shy-ant). */
fun feedItemToEntry(i: FeedItemRow, feed: FeedRow?, rules: InboxRules): InboxEntry? {
    val route = rules.routeForFeed(i.feedId)
    if (route == "hidden") return null
    return InboxEntry(
        key = "feed:${i.id}",
        source = InboxSource.FEED,
        sourceId = i.id,
        header = i.title,
        body = feed?.title ?: "",
        ts = i.publishedAt,
        inInbox = route == "inbox",
        routeKey = i.feedId,
        hiddenFolder = isHiddenFolder(feed?.folder),
        feedKind = feedKind(feed),
        icon = feed?.imageUrl,
        image = i.imageUrl,
    )
}

// --------------------------------------------------------------------------
// Ordering — the SPA's bands (src/inbox/route.ts `band`, keep in sync):
// overdue → agents asking for Yousef (@amar, or a #blocked card — same tier,
// ^mild-ibis) → review hand-backs (turn ended + card Under Review) →
// chat+mail merged by recency (fresh mail must not sink under stale group
// unreads) → finished unread agents → inbox-routed feed items. Recency
// within each band. A still-running agent never reaches the list unless it
// needs attention (^neat-fawn), so there is no "still typing" band.
// --------------------------------------------------------------------------

private fun band(e: InboxEntry): Int = when {
    e.overdue -> 0
    e.source == InboxSource.AGENT -> when {
        e.attention || e.blocked -> 1
        e.review -> 2
        else -> 4
    }
    e.source == InboxSource.CHAT || e.source == InboxSource.MAIL -> 3
    else -> 6
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

/** `snoozed` = every currently-snoozed item across all four sources, soonest
 *  due first — the SPA's snoozed view (Clock toggle). */
data class InboxLists(
    val feed: List<InboxEntry>,
    val inbox: List<InboxEntry>,
    val snoozed: List<InboxEntry> = emptyList(),
)

/**
 * @param snoozedKeys local item-key snoozes still in force (`feed:<id>` /
 *   `agent:<sessionId>` → until). Mail/chat snoozes live on their rows.
 * @param spaces the hub's spaces list — every agent-row join (review
 *   hand-backs, #blocked cards, owned-card headers, space titles) derives
 *   from it, so the Inbox never loads a board.
 */
fun composeInbox(
    threads: List<MailThreadRow>,
    rooms: List<ChatRoomRow>,
    feedItems: List<FeedItemRow>,
    feedsById: Map<String, FeedRow>,
    readIds: Set<String>,
    snoozedKeys: Map<String, Long>,
    sessions: List<AgentSessionRow>,
    rules: InboxRules,
    now: Long,
    xOnly: Boolean = false,
    spaces: List<io.amar.console.data.spaces.SpacesRepository.SpaceSummary> = emptyList(),
): InboxLists {
    val reviewKeys = spaces.flatMapTo(HashSet()) { it.reviewAgentKeys }
    val blockedKeys = blockedAgentKeys(spaces)
    val titles = spaces.associate { it.slug to it.title }
    val titleOf: (String) -> String? = { titles[it] }
    val cardTextOf: (String) -> String? = { ownedCardText(it, spaces) }
    val snoozed = ArrayList<InboxEntry>()
    val all = buildList {
        for (t in threads) {
            if (threadIsLive(t, now)) add(threadToEntry(t, rules))
            else if (t.isInbox && t.snoozedUntil != null && t.snoozedUntil > now) snoozed += threadToEntry(t, rules).copy(snoozedUntil = t.snoozedUntil)
        }
        for (r in rooms) {
            if (roomIsLive(r, now)) add(roomToEntry(r, rules, now))
            else if (r.snoozedUntil != null && r.snoozedUntil > now && !r.isLowPriority && !r.isMuted) snoozed += roomToEntry(r, rules, now).copy(snoozedUntil = r.snoozedUntil)
        }
        for (i in feedItems) {
            if (i.id in readIds) continue
            val e = feedItemToEntry(i, feedsById[i.feedId], rules) ?: continue
            val until = snoozedKeys[e.key]
            if (until != null && until > now) snoozed += e.copy(snoozedUntil = until) else add(e)
        }
        for (s in sessions) {
            if (!sessionIsLive(s)) continue
            val e = sessionToEntry(s, reviewKeys, titleOf, blockedKeys, cardTextOf)
            val until = snoozedKeys[e.key]
            if (until != null && until > now) snoozed += e.copy(snoozedUntil = until) else add(e)
        }
    }
    return InboxLists(
        feed = sortFeed(filterByFeedMode(all.filter { !it.inInbox }, xOnly)),
        inbox = sortInbox(all.filter { it.inInbox }),
        snoozed = snoozed.sortedBy { it.snoozedUntil },
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

/** One persisted routing override, resolved for display (SPA `RouteOverrides`). */
data class RouteOverride(
    val source: InboxSource,
    /** The rules-map key: room id / lowercased sender email / feed id. */
    val key: String,
    /** Room name / sender email / feed title — the key itself when unresolvable. */
    val label: String,
    /** 'feed' | 'inbox' | 'hidden'. */
    val route: String,
)

/** Every override in [rules], chat → mail → feeds, each group sorted by label. */
fun listOverrides(
    rules: InboxRules,
    roomNames: Map<String, String>,
    feedTitles: Map<String, String>,
): List<RouteOverride> {
    fun group(source: InboxSource, map: Map<String, String>, label: (String) -> String) =
        map.map { (k, v) -> RouteOverride(source, k, label(k).ifBlank { k }, v) }
            .sortedBy { it.label.lowercase() }
    return group(InboxSource.CHAT, rules.chatRooms) { roomNames[it] ?: it } +
        group(InboxSource.MAIL, rules.mailSenders) { it } +
        group(InboxSource.FEED, rules.feedFeeds) { feedTitles[it] ?: it }
}

/** Drop one override so its source falls back to the section default. */
fun withoutOverride(rules: InboxRules, source: InboxSource, key: String): InboxRules = when (source) {
    InboxSource.CHAT -> rules.copy(chatRooms = rules.chatRooms - key)
    InboxSource.MAIL -> rules.copy(mailSenders = rules.mailSenders - key)
    InboxSource.FEED -> rules.copy(feedFeeds = rules.feedFeeds - key)
    InboxSource.AGENT -> rules
}
