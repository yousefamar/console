package io.amar.console.data.spaces

import io.amar.console.core.HubClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Spaces domain (SPA SpacesTab parity, mobile-shaped). A space = a vault
 * PROJECT (folder/flat .md under projects/) or an AREA (_data/areas.json
 * entry). Boards are Obsidian-Kanban markdown IN the vault — the same file
 * humans, agents, and the hub's dispatch watcher edit, so board writes go
 * through the lossless KanbanCodec and PUT with baseMtime (409 → reload;
 * stricter than the SPA, which last-writer-wins).
 *
 * Transient/online-leaning by design for v1: spaces list + boards fetch over
 * HTTP on entry (the vault is the persistence; notes offline cache already
 * covers Docs reads via NotesRepository).
 */
class SpacesRepository(private val hub: HubClient) {
    private val json = Json { ignoreUnknownKeys = true }

    data class SpaceSummary(
        val kind: String, // project | area
        val slug: String,
        val title: String,
        val notePath: String?,
        val boardPath: String?,
        val status: String?, // active | dormant | complete | null
        val fileCount: Int,
    )

    data class LoadedBoard(
        val path: String,
        val board: KanbanBoard,
        /** Server mtime at load — echoed back as baseMtime on save. */
        val mtime: Long?,
    )

    private val _spaces = MutableStateFlow<List<SpaceSummary>>(emptyList())
    val spaces: StateFlow<List<SpaceSummary>> = _spaces
    private val _board = MutableStateFlow<LoadedBoard?>(null)
    val board: StateFlow<LoadedBoard?> = _board

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
                )
            } ?: emptyList()
        }
    }

    suspend fun loadBoard(path: String) {
        runCatching {
            val resp = json.parseToJsonElement(hub.get("/notes/file/" + java.net.URLEncoder.encode(path, "UTF-8"))).jsonObject
            val content = resp["content"]?.jsonPrimitive?.content ?: return
            _board.value = LoadedBoard(path, KanbanCodec.parse(content), resp["mtime"]?.jsonPrimitive?.longOrNull)
        }
    }

    fun clearBoard() { _board.value = null }

    /**
     * Mutate-and-save: apply [mutate] to a fresh copy of the loaded board,
     * serialize losslessly, PUT with baseMtime. A 409 (concurrent edit by
     * Obsidian/agent/hub-stamp) or any failure → reload from the hub and
     * return false so the UI re-renders truth instead of a phantom.
     */
    suspend fun mutateBoard(mutate: (KanbanBoard) -> Boolean): Boolean {
        val loaded = _board.value ?: return false
        val b = KanbanCodec.parse(KanbanCodec.serialize(loaded.board)) // defensive copy via round-trip
        if (!mutate(b)) return false
        val body = buildJsonObject {
            put("content", KanbanCodec.serialize(b))
            loaded.mtime?.let { put("baseMtime", it) }
        }
        val ok = runCatching {
            val resp = json.parseToJsonElement(
                hub.put("/notes/file/" + java.net.URLEncoder.encode(loaded.path, "UTF-8"), body.toString())
            ).jsonObject
            _board.value = LoadedBoard(loaded.path, b, resp["mtime"]?.jsonPrimitive?.longOrNull)
        }.isSuccess
        if (!ok) loadBoard(loaded.path)
        return ok
    }
}
