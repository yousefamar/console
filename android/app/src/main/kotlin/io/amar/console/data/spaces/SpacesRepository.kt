package io.amar.console.data.spaces

import io.amar.console.core.HubClient
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * Spaces domain — hub-API-first (spaces-parity-report.md M1/M2 shape).
 *
 * Boards: ALL reads and mutations go through the hub's BoardOps routes
 * (`GET /board/:project`, `POST /board/:project/{cards,move,assign,block,
 * note,edit,remove}`) — the hub holds a per-board write queue, so concurrent
 * editors (Obsidian, agents, SPA, this app) serialize instead of clobbering.
 * The v1 approach (raw /notes/file/ PUT of re-serialized markdown) is GONE:
 * clients never hand-write board files. Cards are addressed by `^id` or a
 * unique text substring; every mutation response is the fresh card view.
 *
 * Live refresh: SyncBus service `boards` broadcasts `changed {boardPath}` +
 * `transition {...}` — any event for the open board re-fetches it.
 */
class SpacesRepository(
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
) {
    private val json = Json { ignoreUnknownKeys = true }

    data class SpaceSummary(
        val kind: String, // project | area
        val slug: String,
        val title: String,
        val notePath: String?,
        val boardPath: String?,
        val status: String?, // active | dormant | complete | null
        val fileCount: Int,
        /** Under-Review card count on the board (0 = none / older hub). */
        val reviewCount: Int = 0,
        /** agentKeys assigned to those review cards. */
        val reviewAgentKeys: List<String> = emptyList(),
        /** EVERY assignee on the board (all columns, dedup'd) — a fork whose
         *  key is here is card-owned: the card is its affordance, so it's
         *  suppressed from L1 alert rows unless it needs attention. */
        val cardAgentKeys: List<String> = emptyList(),
    )

    /** Hub CardView (board-ops.ts): detail = trimmed continuation lines. */
    data class CardView(
        val text: String,
        val column: String,
        val agentKey: String?,
        val blockId: String?,
        val blocked: Boolean,
        val checked: Boolean,
        /** #nofork — dispatch wakes the role directly (no per-ticket fork). */
        val nofork: Boolean = false,
        /** #model/<alias> — ticket-fork model pin (haiku/sonnet/opus). */
        val model: String? = null,
        val detail: List<String>,
    )

    data class BoardColumnView(val title: String, val cards: List<CardView>)
    data class BoardView(
        val project: String,
        val path: String,
        val columns: List<BoardColumnView>,
        /** Board frontmatter default_owner (agentKey), if any. */
        val defaultOwner: String? = null,
    )

    private val _spaces = MutableStateFlow<List<SpaceSummary>>(emptyList())
    val spaces: StateFlow<List<SpaceSummary>> = _spaces
    private val _board = MutableStateFlow<BoardView?>(null)
    val board: StateFlow<BoardView?> = _board
    private val _boardError = MutableStateFlow<String?>(null)
    val boardError: StateFlow<String?> = _boardError

    /** Wire the boards live-refresh subscription once (AppGraph). */
    fun wireLive(scope: CoroutineScope) {
        var spacesRefresh: kotlinx.coroutines.Job? = null
        syncBus.on("boards", "*") { data ->
            // ANY board event can change review/card assignee sets → refresh
            // the spaces LIST too (1s debounce — transitions arrive in bursts)
            // so L1 review badges + fork suppression track live (SPA parity).
            spacesRefresh?.cancel()
            spacesRefresh = scope.launch {
                kotlinx.coroutines.delay(1_000)
                runCatching { refreshSpaces() }
            }
            val path = runCatching {
                data.jsonObject["boardPath"]?.jsonPrimitive?.content
            }.getOrNull()
            val open = _board.value ?: return@on
            // transition events carry boardPath; changed too. No path → refresh anyway.
            if (path == null || path == open.path) {
                scope.launch { runCatching { loadBoard(open.project) } }
            }
        }
        // Broadcasts missed while the WS was down are unrecoverable — re-read
        // the open board + spaces list on every reconnect.
        syncBus.onConnect {
            scope.launch {
                runCatching { refreshSpaces() }
                _board.value?.let { runCatching { loadBoard(it.project) } }
            }
        }
    }

    suspend fun refreshSpaces() {
        runCatching {
            val resp = json.parseToJsonElement(hub.get("/blog/spaces")).jsonObject
            _spaces.value = (resp["spaces"] as? JsonArray)?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                SpaceSummary(
                    kind = o["kind"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                    slug = o["slug"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                    title = o["title"]?.jsonPrimitive?.content ?: o["slug"]!!.jsonPrimitive.content,
                    notePath = o["notePath"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
                    boardPath = o["boardPath"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
                    status = o["status"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
                    fileCount = o["fileCount"]?.jsonPrimitive?.intOrNull ?: 0,
                    reviewCount = o["reviewCount"]?.jsonPrimitive?.intOrNull ?: 0,
                    reviewAgentKeys = (o["reviewAgentKeys"] as? JsonArray)
                        ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
                    cardAgentKeys = (o["cardAgentKeys"] as? JsonArray)
                        ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
                )
            } ?: emptyList()
        }
    }

    suspend fun loadBoard(project: String) {
        runCatching {
            val resp = json.parseToJsonElement(hub.get("/board/" + java.net.URLEncoder.encode(project, "UTF-8"))).jsonObject
            val cols = (resp["columns"] as? JsonArray)?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                BoardColumnView(
                    title = o["title"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                    cards = (o["cards"] as? JsonArray)?.mapNotNull { cardFrom(it as? JsonObject) } ?: emptyList(),
                )
            } ?: emptyList()
            _board.value = BoardView(
                project, resp["path"]?.jsonPrimitive?.content ?: "", cols,
                defaultOwner = resp["defaultOwner"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
            )
            _boardError.value = null
        }.onFailure { _boardError.value = it.message }
    }

    fun clearBoard() { _board.value = null; _boardError.value = null }

    /** Dismiss the sticky mutation-error banner. */
    fun clearError() { _boardError.value = null }

    private fun cardFrom(o: JsonObject?): CardView? {
        if (o == null) return null
        return CardView(
            text = o["text"]?.jsonPrimitive?.content ?: return null,
            column = o["column"]?.jsonPrimitive?.content ?: "",
            agentKey = o["agentKey"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
            blockId = o["blockId"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
            blocked = o["blocked"]?.jsonPrimitive?.content == "true",
            checked = o["checked"]?.jsonPrimitive?.content == "true",
            nofork = o["nofork"]?.jsonPrimitive?.content == "true",
            model = o["model"]?.let { if (it is JsonNull) null else it.jsonPrimitive.content },
            detail = (o["detail"] as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
        )
    }

    /** Card address for BoardOps: `^id` when stamped, else the exact text
     *  (unique-substring resolution is the hub's). */
    fun cardAddress(c: CardView): String = c.blockId?.let { "^$it" } ?: c.text

    // --- mutations (hub-serialized; every call re-loads the board after) --- //

    private suspend fun post(project: String, verb: String, body: JsonObject): Boolean {
        val ok = runCatching {
            val resp = hub.post("/board/" + java.net.URLEncoder.encode(project, "UTF-8") + "/" + verb, body.toString())
            val o = json.parseToJsonElement(resp).jsonObject
            if (o["error"] != null) throw IllegalStateException(o["error"]!!.jsonPrimitive.content)
        }.onFailure { _boardError.value = it.message }.isSuccess
        loadBoard(project) // truth after every attempt, success or not
        return ok
    }

    suspend fun setNofork(project: String, card: CardView, nofork: Boolean): Boolean =
        post(project, "nofork", buildJsonObject { put("card", cardAddress(card)); put("nofork", nofork) })

    suspend fun setModel(project: String, card: CardView, model: String?): Boolean =
        post(project, "model", buildJsonObject {
            put("card", cardAddress(card))
            if (model == null) put("model", "") else put("model", model)
        })

    /** Board-level frontmatter `default_owner:` — the agent unassigned cards
     *  dragged into In Progress auto-assign to. Null clears it. */
    suspend fun setDefaultOwner(project: String, agent: String?): Boolean =
        post(project, "owner", buildJsonObject { if (agent == null) put("agent", "") else put("agent", agent) })

    /** Re-fire dispatch for a STAMPED card (assignee dead / envelope lost). */
    suspend fun redispatch(project: String, card: CardView): Boolean =
        post(project, "redispatch", buildJsonObject { put("card", cardAddress(card)) })

    suspend fun moveCard(project: String, card: CardView, to: String): Boolean =
        post(project, "move", buildJsonObject { put("card", cardAddress(card)); put("to", to) })

    suspend fun assignCard(project: String, card: CardView, agent: String?): Boolean =
        post(project, "assign", buildJsonObject {
            put("card", cardAddress(card))
            if (agent == null) put("agent", JsonNull) else put("agent", agent)
        })

    suspend fun setBlocked(project: String, card: CardView, blocked: Boolean, note: String? = null): Boolean =
        post(project, "block", buildJsonObject {
            put("card", cardAddress(card)); put("blocked", blocked)
            note?.let { put("note", it) }
        })

    /** Add a card (hub top-inserts by default). Retries ONCE on failure —
     *  transient hub hiccups shouldn't eat a typed card (SPA parity,
     *  store/spaces.ts add-retry); the caller keeps the text on false. */
    suspend fun addCard(project: String, text: String, column: String?, detail: List<String> = emptyList()): Boolean {
        val body = buildJsonObject {
            put("text", text)
            column?.let { put("column", it) }
            if (detail.isNotEmpty()) putJsonArray("detail") { detail.forEach { add(it) } }
        }
        if (post(project, "cards", body)) return true
        return post(project, "cards", body)
    }

    suspend fun editCard(project: String, card: CardView, text: String?, detail: List<String>?): Boolean =
        post(project, "edit", buildJsonObject {
            put("card", cardAddress(card))
            text?.let { put("text", it) }
            detail?.let { d -> putJsonArray("detail") { d.forEach { add(it) } } }
        })

    suspend fun removeCard(project: String, card: CardView): Boolean =
        post(project, "remove", buildJsonObject { put("card", cardAddress(card)) })

    /** Create a fresh board for a board-less project (SPA createBoard parity:
     *  writing a NEW file via /notes/file is the sanctioned path — BoardOps
     *  only mutates existing boards). Refreshes spaces so boardPath appears. */
    suspend fun createBoard(slug: String): Boolean {
        val path = "projects/$slug/board.md"
        val ok = runCatching {
            hub.put(
                "/notes/file/" + java.net.URLEncoder.encode(path, "UTF-8"),
                buildJsonObject { put("content", BOARD_TEMPLATE) }.toString(),
            )
        }.onFailure { _boardError.value = it.message }.isSuccess
        if (ok) { refreshSpaces(); loadBoard(slug) }
        return ok
    }

    companion object {
        /** Byte-identical to the SPA's BOARD_TEMPLATE (store/spaces.ts). */
        val BOARD_TEMPLATE = listOf(
            "---", "", "kanban-plugin: board", "", "---", "",
            "## Backlog", "", "",
            "## In Progress", "", "",
            "## Under Review", "", "",
            "## Done", "", "",
        ).joinToString("\n") + "\n"
    }
}
