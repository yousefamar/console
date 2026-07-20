package io.amar.console.data.notes

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MetaRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Notes domain: vault listing mirror + cached bodies + conditional saves.
 *
 * Sync model (uses the M4 hub endpoints):
 *  - reconcile: GET /notes?since=<cursor> → upsert changed metadata, delete
 *    tombstoned paths, refresh cached bodies for files we hold that changed.
 *    First run: full GET /notes listing (metadata only; bodies on open).
 *  - open: read cached body if present; else fetch + cache with its mtime.
 *  - save: optimistic cache write (dirty=true) + queued conditional PUT with
 *    baseMtime. 409 → Conflict parking (row keeps BOTH copies for the merge
 *    screen). Success → dirty=false, new mtime armed.
 */
class NotesRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
    private val outbox: Outbox,
) {
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        const val CURSOR_KEY = "notes:lastSync"
        const val TYPE_SAVE = "noteSave"
        const val TYPE_RENAME = "noteRename"
        const val TYPE_DELETE = "noteDelete"
        const val TABS_OPEN_KEY = "notes:openTabs"
        const val TABS_ACTIVE_KEY = "notes:activeTab"
    }

    fun observeFiles(): Flow<List<NoteFileRow>> = db.notes().observeAll()
    fun observeFile(path: String): Flow<NoteFileRow?> = db.notes().observeFile(path)

    /**
     * App-scoped multi-file tab model (survives navigation within the pane).
     * Persists its open-path list + active path to the Room meta KV. UI reads
     * [NotesTabs.state]; a blocking persist runner is fine (fire-and-forget on
     * the app scope isn't available here, so persistence is best-effort via a
     * detached coroutine created lazily).
     */
    val tabs: NotesTabs by lazy {
        NotesTabs(persist = { open, active ->
            tabsPersistScope.launch { persistTabs(open, active) }
        })
    }
    private val tabsPersistScope by lazy {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)
    }

    /** Blog tooling (drafts/projects/tags/publish) — shares the hub client. */
    val blog: BlogRepository by lazy { BlogRepository(hub) }

    /** Parked conflict rows for the editor's banner. */
    fun observeConflict(path: String): Flow<List<io.amar.console.data.db.OutboxRow>> =
        db.outbox().observeByEntityStatus(TYPE_SAVE, path, "conflict")

    /** Full-text search over offline-cached bodies. */
    suspend fun searchContent(query: String): List<NoteFileRow> =
        if (query.isBlank()) emptyList() else db.notes().searchContent(query.trim(), 50)

    /** Body for the editor: cached copy or fetch-and-cache. */
    suspend fun openFile(path: String): String? {
        val row = db.notes().byPath(path)
        if (row?.cachedContent != null) return row.cachedContent
        return fetchBody(path)
    }

    private suspend fun fetchBody(path: String): String? {
        val resp = runCatching { hub.get("/notes/file/${encPath(path)}") }.getOrNull() ?: return null
        val content = json.parseToJsonElement(resp).jsonObject["content"]?.jsonPrimitive?.content ?: return null
        val row = db.notes().byPath(path)
        db.notes().setContent(path, content, row?.mtime, dirty = false)
        return content
    }

    /**
     * Freshest durable body straight from the hub, bypassing the cache — used
     * by the pen-page viewer to show the newest SVG after switching pages
     * (cached tab content is captured on open and doesn't update as strokes
     * are written). Falls back to the cache on failure.
     */
    suspend fun fetchFreshBody(path: String): String? = fetchBody(path) ?: openFile(path)

    /** Optimistic save: cache immediately, queue the conditional PUT. */
    suspend fun save(path: String, content: String) {
        val row = db.notes().byPath(path)
        val baseMtime = row?.contentMtime ?: row?.mtime
        db.notes().setContent(path, content, baseMtime, dirty = true)
        val payload = buildJsonObject {
            put("path", path)
            put("content", content)
            baseMtime?.let { put("baseMtime", it) }
        }
        outbox.enqueue(TYPE_SAVE, payload.toString(), entityId = path)
    }

    /** Conflict resolution: keep mine = force save without precondition. */
    suspend fun resolveKeepMine(path: String, content: String) {
        db.outbox().removeByEntityAllStatuses(path, TYPE_SAVE) // incl. the parked conflict row
        db.notes().setContent(path, content, null, dirty = true)
        val payload = buildJsonObject {
            put("path", path)
            put("content", content)
            // No baseMtime → legacy last-writer-wins (explicit user choice).
        }
        outbox.enqueue(TYPE_SAVE, payload.toString(), entityId = path)
    }

    /** Conflict resolution: take server copy. */
    suspend fun resolveTakeServer(path: String) {
        db.outbox().removeByEntityAllStatuses(path, TYPE_SAVE) // incl. the parked conflict row
        db.notes().setContent(path, null, null, dirty = false)
        fetchBody(path)
    }

    // ---------------------------------------------------------------- //
    // Create / rename / delete

    /** New note: optimistic cache row + queued save (server creates on PUT). */
    suspend fun create(path: String, content: String = "") {
        val now = System.currentTimeMillis()
        db.notes().upsertAll(
            listOf(
                NoteFileRow(
                    path = path, name = path.substringAfterLast('/'),
                    dir = path.substringBeforeLast('/', ""), mtime = now, size = content.length.toLong(),
                    cachedContent = content, contentMtime = null, dirty = true,
                )
            )
        )
        val payload = buildJsonObject {
            put("path", path)
            put("content", content)
            // No baseMtime — new file, nothing to conflict with.
        }
        outbox.enqueue(TYPE_SAVE, payload.toString(), entityId = path)
    }

    /** Rename: optimistic row move + queued POST /notes/rename. */
    suspend fun rename(from: String, to: String) {
        val row = db.notes().byPath(from) ?: return
        db.withTransaction {
            db.notes().deleteByPath(from)
            db.notes().upsertAll(
                listOf(
                    row.copy(
                        path = to, name = to.substringAfterLast('/'),
                        dir = to.substringBeforeLast('/', ""),
                    )
                )
            )
        }
        val payload = buildJsonObject {
            put("from", from)
            put("to", to)
        }
        outbox.enqueue(TYPE_RENAME, payload.toString(), entityId = from)
    }

    /** Delete: optimistic row removal + queued DELETE /notes/file/<path>. */
    suspend fun delete(path: String) {
        db.notes().deleteByPath(path)
        // A never-flushed local create just cancels; deleting server-side too is
        // harmless (404 = done) so always queue.
        db.outbox().removeByEntityAllStatuses(path, TYPE_SAVE)
        val payload = buildJsonObject { put("path", path) }
        outbox.enqueue(TYPE_DELETE, payload.toString(), entityId = path)
    }

    // ---------------------------------------------------------------- //
    // Image assets (paste / camera / insert) — mirror src/store/notes.ts.

    /**
     * Upload image bytes to the sibling blog-assets dir via the hub (Obsidian
     * attachment folder + Eleventy passthrough → publishes on the live site).
     * Returns the bare filename for a wiki-embed `![[name]]`, or a vault-local
     * fallback path when the hub is unreachable, or null on total failure.
     */
    suspend fun pasteImage(bytes: ByteArray, filename: String, contentType: String): AssetResult? =
        withContext(Dispatchers.IO) {
            // Preferred: hub PUT to the sibling assets dir (shared putRaw helper).
            runCatching {
                hub.putRaw("/notes/asset/${enc("images/$filename")}", bytes, contentType)
                return@withContext AssetResult(filename, wikiEmbed = true)
            }
            // Offline fallback: write inside the vault via a queued save. Won't
            // publish, but the content isn't lost. Store as base64 in a save-
            // like note row is wrong for binary — so we PUT to the raw asset
            // endpoint on next connect via the outbox is overkill; instead we
            // just report failure so the caller can toast (matches "won't lose"
            // being best-effort on mobile without an FSA adapter).
            null
        }

    data class AssetResult(val ref: String, val wikiEmbed: Boolean)

    /**
     * Resolve a vault-relative or bare-filename image reference to raw bytes,
     * trying Obsidian-style fallbacks then the hub's sibling assets dir.
     * Returns (bytes, contentType) or null (broken image). Mirrors
     * resolveImageUrl in src/store/notes.ts.
     */
    suspend fun resolveImage(ref: String, fromFile: String): Pair<ByteArray, String>? =
        withContext(Dispatchers.IO) {
            val fileDir = if (fromFile.contains('/')) fromFile.substringBeforeLast('/') else ""
            val bare = ref.substringAfterLast('/')
            val candidates = LinkedHashSet<String>()
            if (ref.contains('/')) {
                // Relative to the file's dir + vault root.
                val parts = if (fileDir.isNotEmpty()) fileDir.split('/').toMutableList() else mutableListOf()
                for (seg in ref.split('/')) when (seg) {
                    ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
                    "." -> {}
                    else -> parts.add(seg)
                }
                candidates.add(parts.joinToString("/"))
                candidates.add(ref)
            } else {
                if (fileDir.isNotEmpty()) candidates.add("$fileDir/$ref")
                candidates.add(ref)
                candidates.add("assets/$ref")
                candidates.add("assets/images/$ref")
                candidates.add("al/assets/$ref")
            }
            // Try the hub /notes/asset/ (vault-rooted files) for each candidate.
            for (p in candidates) fetchAssetBytes("/notes/file/${encPath(p)}", jsonWrapped = true)?.let { return@withContext it }
            // Sibling assets dir (outside vault root).
            for (assetPath in listOf("images/$bare", bare)) {
                fetchAssetBytes("/notes/asset/${enc(assetPath)}", jsonWrapped = false)?.let { return@withContext it }
            }
            null
        }

    private suspend fun fetchAssetBytes(path: String, jsonWrapped: Boolean): Pair<ByteArray, String>? =
        runCatching {
            if (jsonWrapped) {
                // /notes/file returns {content} text — only useful for text; skip binary.
                null
            } else {
                hub.getRaw(path).use { resp ->
                    val ct = resp.header("Content-Type") ?: "application/octet-stream"
                    val bytes = resp.body?.bytes() ?: return@use null
                    bytes to ct
                }
            }
        }.getOrNull()

    // ---------------------------------------------------------------- //
    // Vault root path (cached) — for starting agent sessions from Notes.

    @Volatile private var vaultPathCache: String? = null
    suspend fun getVaultPath(): String? {
        vaultPathCache?.let { return it }
        val resp = runCatching { hub.get("/notes/vault-path") }.getOrNull() ?: return null
        val p = runCatching { json.parseToJsonElement(resp).jsonObject["path"]?.jsonPrimitive?.content }.getOrNull()
        if (p != null) vaultPathCache = p
        return p
    }

    // ---------------------------------------------------------------- //
    // Open-tabs persistence (Room meta KV) — restored after files load.

    suspend fun persistTabs(openPaths: List<String>, active: String?) {
        db.meta().put(MetaRow(TABS_OPEN_KEY, openPaths.joinToString("\n")))
        db.meta().put(MetaRow(TABS_ACTIVE_KEY, active ?: ""))
    }

    /** Persisted (openPaths, activePath) from a previous session. */
    suspend fun restoreTabs(): Pair<List<String>, String?> {
        val open = db.meta().get(TABS_OPEN_KEY)?.split("\n")?.filter { it.isNotBlank() } ?: emptyList()
        val active = db.meta().get(TABS_ACTIVE_KEY)?.ifBlank { null }
        return open to active
    }

    // ---------------------------------------------------------------- //
    // Directory helpers for the new-note dir picker.

    /**
     * Distinct directories sorted by most-recent file mtime (descending), with
     * 'scratch' always present and pinned first. Mirrors getDirectoriesByRecency
     * in src/store/notes.ts.
     */
    suspend fun directoriesByRecency(): List<String> {
        val rows = db.notes().observeAll().firstOrNull() ?: emptyList()
        val recency = HashMap<String, Long>()
        for (r in rows) {
            if (r.dir.isEmpty()) continue
            // Every ancestor dir counts (a file deep in a/b/c touches a, a/b, a/b/c).
            val parts = r.dir.split('/')
            for (i in parts.indices) {
                val dir = parts.subList(0, i + 1).joinToString("/")
                if ((recency[dir] ?: Long.MIN_VALUE) < r.mtime) recency[dir] = r.mtime
            }
        }
        recency.putIfAbsent("scratch", recency["scratch"] ?: 0L)
        val sorted = recency.entries.sortedByDescending { it.value }.map { it.key }.toMutableList()
        // Pin scratch first.
        sorted.remove("scratch")
        sorted.add(0, "scratch")
        return sorted
    }

    // ---------------------------------------------------------------- //
    // Pen live-activity: SyncBus 'pen' events drive the Notes red-dot +
    // auto-open of the actively-written page, and register new page files in
    // the listing without a rescan. Mirrors the module-level block in
    // src/store/notes.ts. PenPageRenderer subscribes to 'pen' separately for
    // the live stroke overlay.

    private val _penActivePagePath = MutableStateFlow<String?>(null)
    val penActivePagePath: StateFlow<String?> = _penActivePagePath
    private val _penActiveAt = MutableStateFlow(0L)
    val penActiveAt: StateFlow<Long> = _penActiveAt
    private val _penStreaming = MutableStateFlow(false)
    val penStreaming: StateFlow<Boolean> = _penStreaming
    @Volatile private var lastPenWrite = 0L
    @Volatile private var penWired = false

    fun clearPenActivity() {
        _penActivePagePath.value = null
    }

    /**
     * Wire the SyncBus 'pen' service — idempotent (safe to call from a
     * composable LaunchedEffect). [scope] runs the listing insert on page_saved.
     */
    fun wirePenActivity(scope: kotlinx.coroutines.CoroutineScope) {
        if (penWired) return
        penWired = true
        syncBus.on("pen", "page_open") { d -> noteActivity(d) }
        syncBus.on("pen", "stroke_delta") { d -> noteActivity(d) }
        syncBus.on("pen", "page_saved") { d ->
            penPath(d)?.let { p -> scope.launch { notePageSaved(p) } }
            noteActivity(d)
        }
        syncBus.on("pen", "streaming") { d ->
            _penStreaming.value = (d as? JsonObject)?.get("active")?.jsonPrimitive?.booleanOrNull == true
        }
        scope.launch { refreshPenStreaming() }
    }

    /** Fetch streaming state once (broadcasts aren't replayed on connect). */
    suspend fun refreshPenStreaming() {
        val resp = runCatching { hub.get("/pen/stream") }.getOrNull() ?: return
        _penStreaming.value = runCatching {
            json.parseToJsonElement(resp).jsonObject["active"]?.jsonPrimitive?.booleanOrNull == true
        }.getOrDefault(false)
    }

    private fun penPath(d: JsonElement?): String? {
        val o = d as? JsonObject ?: return null
        o["relPath"]?.jsonPrimitive?.content?.let { return it }
        val note = o["note"]?.jsonPrimitive?.intOrNull
        val page = o["page"]?.jsonPrimitive?.intOrNull
        return if (note != null && page != null) "scratch/pen/$note/page-$page.svg" else null
    }

    private fun noteActivity(d: JsonElement?) {
        val relPath = penPath(d) ?: return
        val now = System.currentTimeMillis()
        val pageChanged = _penActivePagePath.value != relPath
        if (!pageChanged && now - lastPenWrite < 1000) return // throttle stroke_delta
        lastPenWrite = now
        _penActivePagePath.value = relPath
        _penActiveAt.value = now
    }

    /**
     * Subscribe to a SyncBus 'pen' op for the live overlay (PenPageScreen).
     * Returns the unsubscribe fn. Kept here so the composable doesn't reach
     * into the SyncBus client directly.
     */
    fun penBus(op: String, handler: (JsonElement) -> Unit): () -> Unit = syncBus.on("pen", op, handler)

    /** Re-read the freshest durable pen SVG and hand it to [onSvg]. */
    fun penReload(path: String, onSvg: (String) -> Unit) {
        tabsPersistScope.launch {
            val svg = fetchFreshBody(path) ?: return@launch
            onSvg(svg)
        }
    }

    /** Insert a newly-saved pen page into the listing (path-sorted) if absent. */
    suspend fun notePageSaved(relPath: String) {
        if (db.notes().byPath(relPath) != null) return
        val now = System.currentTimeMillis()
        db.notes().upsertAll(
            listOf(
                NoteFileRow(
                    path = relPath, name = relPath.substringAfterLast('/'),
                    dir = relPath.substringBeforeLast('/', ""), mtime = now, size = 0L,
                    cachedContent = null, contentMtime = null, dirty = false,
                )
            )
        )
    }

    fun registerOutboxHandlers() {
        outbox.register(TYPE_SAVE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            val path = p["path"]!!.jsonPrimitive.content
            try {
                val body = buildJsonObject {
                    put("content", p["content"]!!.jsonPrimitive.content)
                    p["baseMtime"]?.jsonPrimitive?.longOrNull?.let { put("baseMtime", it) }
                    p["baseMtime"]?.jsonPrimitive?.doubleOrNull?.let { put("baseMtime", it) }
                }
                val resp = hub.put("/notes/file/${encPath(path)}", body.toString())
                val newMtime = json.parseToJsonElement(resp).jsonObject["mtime"]?.jsonPrimitive?.doubleOrNull?.toLong()
                val current = db.notes().byPath(path)
                db.notes().setContent(path, current?.cachedContent, newMtime, dirty = false)
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code == 409) {
                    // Someone edited elsewhere while we were offline — park
                    // for the conflict screen; the server copy is in e.body.
                    Outbox.Result.Conflict("Edited elsewhere — resolve in Notes")
                } else if (e.code in 400..499) {
                    Outbox.Result.Fail("HTTP ${e.code}")
                } else {
                    Outbox.Result.Retry("HTTP ${e.code}")
                }
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }

        outbox.register(TYPE_RENAME) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                hub.post("/notes/rename", buildJsonObject {
                    put("from", p["from"]!!.jsonPrimitive.content)
                    put("to", p["to"]!!.jsonPrimitive.content)
                }.toString())
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}") else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }

        outbox.register(TYPE_DELETE) { row, _ ->
            val p = json.parseToJsonElement(row.payloadJson).jsonObject
            try {
                hub.delete("/notes/file/${encPath(p["path"]!!.jsonPrimitive.content)}")
                Outbox.Result.Done
            } catch (e: HubClient.HttpException) {
                if (e.code == 404 || e.code == 410) Outbox.Result.Done // already gone
                else if (e.code in 400..499) Outbox.Result.Fail("HTTP ${e.code}")
                else Outbox.Result.Retry("HTTP ${e.code}")
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
    }

    suspend fun reconcile() {
        val cursor = db.meta().get(CURSOR_KEY)?.toLongOrNull()
        if (cursor == null) {
            fullListing()
            return
        }
        val resp = runCatching { hub.get("/notes?since=$cursor") }.getOrNull() ?: return
        val obj = json.parseToJsonElement(resp).jsonObject
        val files = (obj["files"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        val deleted = (obj["deleted"] as? JsonArray)
            ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList()

        db.withTransaction {
            if (deleted.isNotEmpty()) db.notes().deleteByPaths(deleted)
            for (f in files) {
                val path = f["path"]?.jsonPrimitive?.content ?: continue
                val mtime = f["mtime"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0L
                val size = f["size"]?.jsonPrimitive?.longOrNull ?: 0L
                val existing = db.notes().byPath(path)
                if (existing == null) {
                    db.notes().upsertAll(listOf(rowFromListing(f)))
                } else {
                    db.notes().updateMeta(path, mtime, size)
                    // Cached body is stale (changed server-side, no local
                    // dirty edit) → drop it; refetched on next open.
                    if (!existing.dirty && existing.contentMtime != null && mtime > existing.contentMtime) {
                        db.notes().setContent(path, null, null, dirty = false)
                    }
                }
            }
            db.meta().put(MetaRow(CURSOR_KEY, System.currentTimeMillis().toString()))
        }
    }

    private suspend fun fullListing() {
        val resp = runCatching { hub.get("/notes") }.getOrNull() ?: return
        val files = (json.parseToJsonElement(resp) as? JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: return
        db.withTransaction {
            val rows = files.mapNotNull { f ->
                if (f["path"]?.jsonPrimitive?.content == null) null else rowFromListing(f)
            }
            val serverPaths = rows.map { it.path }.toSet()
            val stale = db.notes().allPaths().filter { it !in serverPaths }
            if (stale.isNotEmpty()) db.notes().deleteByPaths(stale)
            // Preserve cached bodies on re-listing.
            for (row in rows) {
                val existing = db.notes().byPath(row.path)
                if (existing == null) db.notes().upsertAll(listOf(row))
                else db.notes().updateMeta(row.path, row.mtime, row.size)
            }
            db.meta().put(MetaRow(CURSOR_KEY, System.currentTimeMillis().toString()))
        }
    }

    private fun rowFromListing(f: JsonObject): NoteFileRow = NoteFileRow(
        path = f["path"]!!.jsonPrimitive.content,
        name = f["name"]?.jsonPrimitive?.content ?: f["path"]!!.jsonPrimitive.content.substringAfterLast('/'),
        dir = f["dir"]?.jsonPrimitive?.content ?: "",
        mtime = f["mtime"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0L,
        size = f["size"]?.jsonPrimitive?.longOrNull ?: 0L,
        cachedContent = null,
        contentMtime = null,
    )

    /** Path segments individually encoded (slashes stay). */
    private fun encPath(path: String): String =
        path.split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }

    /** Full URL-encode (for query params / single-segment asset names). */
    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
