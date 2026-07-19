package io.amar.console.data.notes

import androidx.room.withTransaction
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.MetaRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
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
    }

    fun observeFiles(): Flow<List<NoteFileRow>> = db.notes().observeAll()
    fun observeFile(path: String): Flow<NoteFileRow?> = db.notes().observeFile(path)

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
}
