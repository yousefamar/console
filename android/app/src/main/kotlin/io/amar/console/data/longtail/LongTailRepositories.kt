package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import io.amar.console.data.db.BookmarkRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

private val json = Json { ignoreUnknownKeys = true }

/** Pure: ["a","b"] JSON → tag list. Tolerates null/garbage (returns empty). */
fun parseTagsJson(tagsJson: String?): List<String> {
    if (tagsJson.isNullOrBlank()) return emptyList()
    return runCatching {
        (json.parseToJsonElement(tagsJson) as? JsonArray)
            ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
            ?.filter { it.isNotBlank() }
    }.getOrNull() ?: emptyList()
}

/**
 * Bookmarks: cached listing browse offline; delete queues through the outbox;
 * body (markdown) is a lazy online fetch (bodies aren't cached — 977 files).
 */
class BookmarksRepository(
    private val db: ConsoleDb,
    private val hub: HubClient,
    private val outbox: Outbox? = null,
) {
    companion object {
        const val TYPE_DELETE = "bookmarkDelete"
    }

    fun observeAll(): Flow<List<BookmarkRow>> = db.bookmarks().observeAll()

    data class Detail(val description: String?, val body: String?)

    /** Lazy detail fetch — GET /bookmarks/<file> returns the full
     *  BookmarkWithBody (description + markdown body). Online-only. */
    suspend fun fetchDetail(file: String): Detail? = runCatching {
        val resp = hub.get("/bookmarks/" + java.net.URLEncoder.encode(file, "UTF-8").replace("+", "%20"))
        val obj = json.parseToJsonElement(resp) as? JsonObject ?: return@runCatching null
        Detail(
            description = obj["description"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
            body = obj["body"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
        )
    }.getOrNull()

    /** Optimistic delete: drop the cached row now, queue the hub DELETE. */
    suspend fun delete(file: String) {
        db.bookmarks().deleteByFile(file)
        val payload = JsonObject(mapOf("file" to kotlinx.serialization.json.JsonPrimitive(file)))
        outbox?.enqueue(TYPE_DELETE, payload.toString(), entityId = file)
    }

    fun registerOutboxHandlers() {
        outbox?.register(TYPE_DELETE) { row, _ ->
            try {
                val file = (json.parseToJsonElement(row.payloadJson) as? JsonObject)
                    ?.get("file")?.jsonPrimitive?.content
                    ?: return@register Outbox.Result.Fail("no file in payload")
                try {
                    hub.delete("/bookmarks/" + java.net.URLEncoder.encode(file, "UTF-8").replace("+", "%20"))
                } catch (e: HubClient.HttpException) {
                    // Already gone hub-side = success (idempotent delete).
                    if (e.code != 404) throw e
                }
                Outbox.Result.Done
            } catch (e: Exception) {
                Outbox.Result.Retry(e.message ?: "network")
            }
        }
    }

    suspend fun reconcile() {
        val resp = runCatching { hub.get("/bookmarks") }.getOrNull() ?: return
        val arr = (json.parseToJsonElement(resp) as? JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: return
        // Don't resurrect rows whose delete hasn't flushed yet.
        val pendingDeletes = db.outbox().pending()
            .filter { it.type == TYPE_DELETE }
            .mapNotNull { it.entityId }
            .toSet()
        val rows = arr.mapNotNull { b ->
            // Hub rows carry `filename` (server/src/bookmarks.ts Bookmark);
            // accept legacy `file` too.
            val file = (b["filename"] ?: b["file"])?.jsonPrimitive?.content ?: return@mapNotNull null
            if (file in pendingDeletes) return@mapNotNull null
            BookmarkRow(
                file = file,
                title = b["title"]?.jsonPrimitive?.content ?: file.removeSuffix(".md"),
                url = b["url"]?.jsonPrimitive?.content,
                tagsJson = (b["tags"] as? JsonArray)?.toString(),
                addedAt = b["added"]?.jsonPrimitive?.content?.let { added ->
                    runCatching { java.time.Instant.parse(added).toEpochMilli() }.getOrNull()
                        ?: runCatching {
                            java.time.LocalDate.parse(added.take(10))
                                .atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
                        }.getOrNull()
                } ?: b["addedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
        }
        if (rows.isNotEmpty()) {
            db.bookmarks().upsertAll(rows)
            db.bookmarks().deleteAbsent(rows.map { it.file } + pendingDeletes.toList())
        }
    }
}

/**
 * Pure: which UI controls the active device forbids. Spotify's
 * `actions.disallows` keys (server/src/spotify/types.ts `disallows: string[]`).
 */
fun shuffleAllowed(disallows: List<String>): Boolean = "toggling_shuffle" !in disallows
fun repeatAllowed(disallows: List<String>): Boolean =
    "toggling_repeat_context" !in disallows && "toggling_repeat_track" !in disallows
fun seekAllowed(disallows: List<String>): Boolean = "seeking" !in disallows

/** Spotify remote — thin online-only mirror of the hub spotify routes. */
class MusicRepository(private val hub: HubClient) {
    data class NowPlaying(
        val track: String,
        val artist: String,
        val isPlaying: Boolean,
        val progressMs: Long,
        val durationMs: Long,
        val device: String?,
        val volumePercent: Int?,
        val albumArt: String?,
        val trackId: String?,
        val shuffle: Boolean,
        val repeat: String,          // off | context | track
        val disallows: List<String>,
        val liked: Boolean?,         // null = unknown / not yet checked
        val fetchedAt: Long,
    )

    data class SearchTrack(
        val uri: String,
        val name: String,
        val artists: String,
        val albumArt: String?,
    )

    private val _state = MutableStateFlow<NowPlaying?>(null)
    val state: StateFlow<NowPlaying?> = _state

    private var likedTrackId: String? = null
    private var likedValue: Boolean? = null

    suspend fun refresh() {
        // GET /spotify/player returns the hub's SpotifyPlayerSnapshot
        // (server/src/spotify/types.ts) — the hub already normalized Spotify's
        // raw shape (artists joined, albumArt resolved, disallows flattened).
        val resp = runCatching { hub.get("/spotify/player") }.getOrNull() ?: return
        val obj = runCatching { json.parseToJsonElement(resp).jsonObject }.getOrNull() ?: return
        val snap = (obj["data"] as? JsonObject) ?: obj
        val item = snap["item"] as? JsonObject
        val trackId = item?.get("id")?.jsonPrimitive?.content
        // Like state: check once per track (free-ish; skip when id unchanged).
        if (trackId != null && trackId != likedTrackId) {
            likedTrackId = trackId
            likedValue = runCatching {
                val saved = hub.get("/spotify/saved?ids=$trackId")
                ((json.parseToJsonElement(saved).jsonObject["saved"]) as? JsonArray)
                    ?.firstOrNull()?.jsonPrimitive?.booleanOrNull
            }.getOrNull()
        }
        _state.value = NowPlaying(
            track = item?.get("name")?.jsonPrimitive?.content ?: "—",
            artist = item?.get("artists")?.jsonPrimitive?.content ?: "",
            isPlaying = snap["isPlaying"]?.jsonPrimitive?.booleanOrNull ?: false,
            progressMs = snap["progressMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            durationMs = item?.get("durationMs")?.jsonPrimitive?.longOrNull ?: 0L,
            device = (snap["device"] as? JsonObject)?.get("name")?.jsonPrimitive?.content,
            volumePercent = (snap["device"] as? JsonObject)?.get("volumePercent")?.jsonPrimitive?.content?.toIntOrNull(),
            albumArt = item?.get("albumArt")?.jsonPrimitive?.content,
            trackId = trackId,
            shuffle = snap["shuffle"]?.jsonPrimitive?.booleanOrNull ?: false,
            repeat = snap["repeat"]?.jsonPrimitive?.content ?: "off",
            disallows = (snap["disallows"] as? JsonArray)
                ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
            liked = if (trackId == likedTrackId) likedValue else null,
            fetchedAt = snap["fetchedAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis(),
        )
    }

    suspend fun toggle() { runCatching { hub.post("/spotify/toggle") }; refresh() }
    suspend fun next() { runCatching { hub.post("/spotify/next") }; refresh() }
    suspend fun prev() { runCatching { hub.post("/spotify/previous") }; refresh() }
    suspend fun volume(pct: Int) { runCatching { hub.post("/spotify/volume", """{"percent":$pct}""") }; refresh() }
    suspend fun seek(positionMs: Long) { runCatching { hub.post("/spotify/seek", """{"positionMs":$positionMs}""") }; refresh() }
    suspend fun setShuffle(state: Boolean) { runCatching { hub.post("/spotify/shuffle", """{"state":$state}""") }; refresh() }

    /** Cycle off → context → track → off (matches the SPA drawer). */
    suspend fun cycleRepeat() {
        val nextState = when (_state.value?.repeat) {
            "off" -> "context"
            "context" -> "track"
            else -> "off"
        }
        runCatching { hub.post("/spotify/repeat", """{"state":"$nextState"}""") }
        refresh()
    }

    suspend fun toggleLike() {
        val id = _state.value?.trackId ?: return
        val nowLiked = !(likedValue ?: false)
        likedValue = nowLiked
        _state.value = _state.value?.copy(liked = nowLiked)
        runCatching {
            hub.post(if (nowLiked) "/spotify/save" else "/spotify/unsave", """{"ids":["$id"]}""")
        }
    }

    suspend fun search(q: String): List<SearchTrack> = runCatching {
        val resp = hub.get("/spotify/search?q=${java.net.URLEncoder.encode(q, "UTF-8")}&limit=10")
        ((json.parseToJsonElement(resp).jsonObject["tracks"]) as? JsonArray)
            ?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                SearchTrack(
                    uri = o["uri"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                    name = o["name"]?.jsonPrimitive?.content ?: "?",
                    artists = o["artists"]?.jsonPrimitive?.content ?: "",
                    albumArt = o["albumArt"]?.jsonPrimitive?.content,
                )
            } ?: emptyList()
    }.getOrDefault(emptyList())

    suspend fun playUri(uri: String) {
        runCatching { hub.post("/spotify/play", """{"uris":["$uri"]}""") }
        refresh()
    }
}
