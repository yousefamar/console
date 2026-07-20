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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

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

    /** A bookmark freshly created by the add flow (server fetched its metadata). */
    data class Created(val file: String, val title: String, val url: String?, val description: String?, val tags: List<String>)

    private fun encPath(file: String) =
        "/bookmarks/" + java.net.URLEncoder.encode(file, "UTF-8").replace("+", "%20")

    /** Lazy detail fetch — GET /bookmarks/<file> returns the full
     *  BookmarkWithBody (description + markdown body). Online-only. */
    suspend fun fetchDetail(file: String): Detail? = runCatching {
        val resp = hub.get(encPath(file))
        val obj = json.parseToJsonElement(resp) as? JsonObject ?: return@runCatching null
        Detail(
            description = obj["description"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
            body = obj["body"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
        )
    }.getOrNull()

    /**
     * Add flow: POST /bookmarks {url} — the server fetches metadata AND creates
     * the file immediately, so the bookmark exists as soon as this returns.
     * Caches the created row so it appears in the list right away.
     */
    suspend fun createBookmark(url: String): Created? = runCatching {
        val body = JsonObject(mapOf("url" to kotlinx.serialization.json.JsonPrimitive(url)))
        val resp = hub.post("/bookmarks", body.toString())
        val obj = json.parseToJsonElement(resp) as? JsonObject ?: return@runCatching null
        val file = (obj["filename"] ?: obj["file"])?.jsonPrimitive?.content ?: return@runCatching null
        val tags = (obj["tags"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
        val created = Created(
            file = file,
            title = obj["title"]?.jsonPrimitive?.content ?: file.removeSuffix(".md"),
            url = obj["url"]?.jsonPrimitive?.content,
            description = obj["description"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
            tags = tags,
        )
        db.bookmarks().upsert(
            BookmarkRow(
                file = created.file,
                title = created.title,
                url = created.url,
                tagsJson = if (tags.isEmpty()) null else JsonArray(tags.map { kotlinx.serialization.json.JsonPrimitive(it) }).toString(),
                addedAt = System.currentTimeMillis(),
                description = created.description,
                archive = obj["archive"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
                addedRaw = obj["added"]?.jsonPrimitive?.content,
            )
        )
        created
    }.getOrNull()

    /** POST /bookmarks/suggest-tags — LLM tags for a URL. Non-blocking add flow. */
    suspend fun suggestTags(title: String, description: String, url: String): List<String> = runCatching {
        val body = buildJsonObject {
            put("title", kotlinx.serialization.json.JsonPrimitive(title))
            put("description", kotlinx.serialization.json.JsonPrimitive(description))
            put("url", kotlinx.serialization.json.JsonPrimitive(url))
        }
        val resp = hub.post("/bookmarks/suggest-tags", body.toString())
        ((json.parseToJsonElement(resp) as? JsonObject)?.get("tags") as? JsonArray)
            ?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
    }.getOrDefault(emptyList())

    /** PUT /bookmarks/<file> {tags}; apply server-confirmed tags locally. Errors swallowed. */
    suspend fun updateTags(file: String, tags: List<String>) {
        runCatching {
            val body = buildJsonObject {
                put("tags", JsonArray(tags.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            }
            val resp = hub.put(encPath(file), body.toString())
            val obj = json.parseToJsonElement(resp) as? JsonObject
            val confirmed = (obj?.get("tags") as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: tags
            db.bookmarks().updateTags(
                file,
                JsonArray(confirmed.map { kotlinx.serialization.json.JsonPrimitive(it) }).toString(),
            )
        }
    }

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
            val addedRaw = b["added"]?.jsonPrimitive?.content
            BookmarkRow(
                file = file,
                title = b["title"]?.jsonPrimitive?.content ?: file.removeSuffix(".md"),
                url = b["url"]?.jsonPrimitive?.content,
                tagsJson = (b["tags"] as? JsonArray)?.toString(),
                addedAt = addedRaw?.let { added ->
                    runCatching { java.time.Instant.parse(added).toEpochMilli() }.getOrNull()
                        ?: runCatching {
                            java.time.LocalDate.parse(added.take(10))
                                .atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
                        }.getOrNull()
                } ?: b["addedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
                description = b["description"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
                archive = b["archive"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
                addedRaw = addedRaw,
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

/** Classify a hub control failure into a friendly toast (mirrors music.ts). */
fun classifyMusicError(e: Throwable?): String {
    val raw = (e as? HubClient.HttpException)?.let { "${it.code} ${it.body}" } ?: (e?.message ?: "")
    return when {
        Regex("device not found|no_active_device|no active device", RegexOption.IGNORE_CASE).containsMatchIn(raw) ->
            "No playback device — open Spotify, pick amarhp-spotifyd, then try again"
        Regex("restriction|\\b403\\b", RegexOption.IGNORE_CASE).containsMatchIn(raw) ->
            "Not supported by this device"
        Regex("not linked|not configured|\\b401\\b", RegexOption.IGNORE_CASE).containsMatchIn(raw) ->
            "Spotify not linked — reconnect from the drawer"
        else -> "Spotify control failed"
    }
}

/** Spotify remote — thin online-only mirror of the hub spotify routes. */
class MusicRepository(private val hub: HubClient) {
    data class Device(val id: String?, val name: String, val isActive: Boolean, val volumePercent: Int?)

    data class NowPlaying(
        val linked: Boolean,
        val track: String?,          // null = nothing playing
        val artist: String,
        val isPlaying: Boolean,
        val progressMs: Long,
        val durationMs: Long,
        val device: String?,
        val deviceId: String?,
        val volumePercent: Int?,
        val albumArt: String?,
        val trackId: String?,
        val trackUri: String?,
        val shuffle: Boolean,
        val repeat: String,          // off | context | track
        val disallows: List<String>,
        val liked: Boolean?,         // null = unknown / not yet checked
        val fetchedAt: Long,
        val devices: List<Device>,
        val spotifydDeviceId: String?,
    )

    data class SearchTrack(
        val uri: String,
        val name: String,
        val artists: String,
        val albumArt: String?,
    )

    data class Playlist(
        val id: String,
        val uri: String,
        val name: String,
        val trackCount: Int,
        val image: String?,
    )

    private val _state = MutableStateFlow<NowPlaying?>(null)
    val state: StateFlow<NowPlaying?> = _state

    private val _playlists = MutableStateFlow<List<Playlist>>(emptyList())
    val playlists: StateFlow<List<Playlist>> = _playlists

    /** Transient error message for the UI to toast; consumer clears it. */
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError
    fun clearError() { _lastError.value = null }

    private var likedTrackId: String? = null
    private var likedValue: Boolean? = null

    private fun devicesOf(snap: JsonObject): List<Device> =
        (snap["devices"] as? JsonArray)?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            Device(
                id = o["id"]?.jsonPrimitive?.content,
                name = o["name"]?.jsonPrimitive?.content ?: "?",
                isActive = o["isActive"]?.jsonPrimitive?.booleanOrNull ?: false,
                volumePercent = o["volumePercent"]?.jsonPrimitive?.content?.toIntOrNull(),
            )
        } ?: emptyList()

    suspend fun refresh() {
        // GET /spotify/player returns the hub's SpotifyPlayerSnapshot
        // (server/src/spotify/types.ts) — the hub already normalized Spotify's
        // raw shape (artists joined, albumArt resolved, disallows flattened).
        val resp = runCatching { hub.get("/spotify/player") }.getOrNull() ?: run {
            // Distinguish "not linked" from a transient failure — a fresh boot
            // needs the not-linked card, but a network blip must keep the last snapshot.
            if (_state.value == null) _state.value = emptyNotPlaying(linked = false)
            return
        }
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
        val device = snap["device"] as? JsonObject
        _state.value = NowPlaying(
            linked = snap["linked"]?.jsonPrimitive?.booleanOrNull ?: true,
            track = item?.get("name")?.jsonPrimitive?.content,
            artist = item?.get("artists")?.jsonPrimitive?.content ?: "",
            isPlaying = snap["isPlaying"]?.jsonPrimitive?.booleanOrNull ?: false,
            progressMs = snap["progressMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            durationMs = item?.get("durationMs")?.jsonPrimitive?.longOrNull ?: 0L,
            device = device?.get("name")?.jsonPrimitive?.content,
            deviceId = device?.get("id")?.jsonPrimitive?.content,
            volumePercent = device?.get("volumePercent")?.jsonPrimitive?.content?.toIntOrNull(),
            albumArt = item?.get("albumArt")?.jsonPrimitive?.content,
            trackId = trackId,
            trackUri = item?.get("uri")?.jsonPrimitive?.content,
            shuffle = snap["shuffle"]?.jsonPrimitive?.booleanOrNull ?: false,
            repeat = snap["repeat"]?.jsonPrimitive?.content ?: "off",
            disallows = (snap["disallows"] as? JsonArray)
                ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList(),
            liked = if (trackId == likedTrackId) likedValue else null,
            fetchedAt = snap["fetchedAt"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis(),
            devices = devicesOf(snap),
            spotifydDeviceId = snap["spotifydDeviceId"]?.jsonPrimitive?.content,
        )
    }

    private fun emptyNotPlaying(linked: Boolean) = NowPlaying(
        linked = linked, track = null, artist = "", isPlaying = false, progressMs = 0, durationMs = 0,
        device = null, deviceId = null, volumePercent = null, albumArt = null, trackId = null, trackUri = null,
        shuffle = false, repeat = "off", disallows = emptyList(), liked = null,
        fetchedAt = System.currentTimeMillis(), devices = emptyList(), spotifydDeviceId = null,
    )

    /** POST a control endpoint; on failure set a friendly toast + re-sync. */
    private suspend fun control(path: String, body: String? = null, thenRefresh: Boolean = true) {
        val r = runCatching { if (body != null) hub.post(path, body) else hub.post(path) }
        if (r.isFailure) {
            _lastError.value = classifyMusicError(r.exceptionOrNull())
        }
        if (thenRefresh) runCatching { refresh() }
    }

    suspend fun toggle() = control("/spotify/toggle")
    suspend fun next() = control("/spotify/next")
    suspend fun prev() = control("/spotify/previous")
    suspend fun volume(pct: Int) = control("/spotify/volume", """{"percent":$pct}""")
    suspend fun seek(positionMs: Long) = control("/spotify/seek", """{"positionMs":$positionMs}""")
    suspend fun setShuffle(state: Boolean) = control("/spotify/shuffle", """{"state":$state}""")

    /** Cycle off → context → track → off (matches the SPA drawer). */
    suspend fun cycleRepeat() {
        val nextState = when (_state.value?.repeat) {
            "off" -> "context"
            "context" -> "track"
            else -> "off"
        }
        control("/spotify/repeat", """{"state":"$nextState"}""")
    }

    suspend fun toggleLike() {
        val id = _state.value?.trackId ?: return
        val nowLiked = !(likedValue ?: false)
        likedValue = nowLiked
        _state.value = _state.value?.copy(liked = nowLiked)
        control(if (nowLiked) "/spotify/save" else "/spotify/unsave", """{"ids":["$id"]}""", thenRefresh = false)
    }

    suspend fun search(q: String): List<SearchTrack> = runCatching {
        val resp = hub.get("/spotify/search?q=${java.net.URLEncoder.encode(q, "UTF-8")}&limit=12")
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

    /** track URIs → {uris}; playlist/album/artist → {contextUri}. */
    suspend fun playUri(uri: String) {
        val body = if (uri.contains(":track:")) """{"uris":["$uri"]}""" else """{"contextUri":"$uri"}"""
        control("/spotify/play", body)
    }

    suspend fun queueUri(uri: String) = control("/spotify/queue", """{"uri":"$uri"}""", thenRefresh = false)

    suspend fun transfer(deviceId: String) = control("/spotify/transfer", """{"deviceId":"$deviceId","play":true}""")

    /** GET /spotify/playlists; on error keeps previous list (no blanking). */
    suspend fun loadPlaylists() {
        val list = runCatching {
            val resp = hub.get("/spotify/playlists")
            ((json.parseToJsonElement(resp).jsonObject["playlists"]) as? JsonArray)
                ?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    Playlist(
                        id = o["id"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                        uri = o["uri"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                        name = o["name"]?.jsonPrimitive?.content ?: "?",
                        trackCount = o["trackCount"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                        image = o["image"]?.jsonPrimitive?.content,
                    )
                } ?: emptyList()
        }.getOrNull()
        if (list != null) _playlists.value = list
    }

    /** Play the first 50 saved tracks as an explicit uris list. */
    suspend fun playLiked() {
        val uris = runCatching {
            val resp = hub.get("/spotify/saved-tracks?limit=50")
            ((json.parseToJsonElement(resp).jsonObject["tracks"]) as? JsonArray)
                ?.mapNotNull { (it as? JsonObject)?.get("uri")?.jsonPrimitive?.content } ?: emptyList()
        }.getOrDefault(emptyList())
        if (uris.isEmpty()) return
        control("/spotify/play", buildJsonObject {
            put("uris", JsonArray(uris.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        }.toString())
    }

    /** Add the now-playing track to a playlist. No-op if nothing playing. */
    suspend fun addCurrentToPlaylist(playlistId: String) {
        val uri = _state.value?.trackUri ?: return
        control("/spotify/playlist/$playlistId/add", """{"uris":["$uri"]}""", thenRefresh = false)
    }
}
