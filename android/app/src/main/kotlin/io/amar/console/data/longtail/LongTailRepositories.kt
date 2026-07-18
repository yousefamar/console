package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import io.amar.console.data.db.BookmarkRow
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.GeocacheRow
import io.amar.console.data.db.MeetupEventRow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

private val json = Json { ignoreUnknownKeys = true }

/** Bookmarks: cached listing browse offline; add/triage online (desktop). */
class BookmarksRepository(private val db: ConsoleDb, private val hub: HubClient) {
    fun observeAll(): Flow<List<BookmarkRow>> = db.bookmarks().observeAll()

    suspend fun reconcile() {
        val resp = runCatching { hub.get("/bookmarks") }.getOrNull() ?: return
        val arr = (json.parseToJsonElement(resp) as? JsonArray)
            ?.mapNotNull { it as? JsonObject } ?: return
        val rows = arr.mapNotNull { b ->
            val file = b["file"]?.jsonPrimitive?.content ?: return@mapNotNull null
            BookmarkRow(
                file = file,
                title = b["title"]?.jsonPrimitive?.content ?: file.removeSuffix(".md"),
                url = b["url"]?.jsonPrimitive?.content,
                tagsJson = (b["tags"] as? JsonArray)?.toString(),
                addedAt = b["addedAt"]?.jsonPrimitive?.longOrNull
                    ?: b["mtime"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0L,
            )
        }
        if (rows.isNotEmpty()) {
            db.bookmarks().upsertAll(rows)
            db.bookmarks().deleteAbsent(rows.map { it.file })
        }
    }
}

/** Map data: geocache + meetup summary mirrors (pins render offline). */
class MapRepository(private val db: ConsoleDb, private val hub: HubClient) {
    suspend fun geocaches(): List<GeocacheRow> = db.map().geocaches()
    suspend fun upcomingMeetup(): List<MeetupEventRow> =
        db.map().upcomingMeetup(System.currentTimeMillis())

    suspend fun reconcile() {
        runCatching {
            val resp = hub.get("/geocaching/caches")
            val arr = (json.parseToJsonElement(resp).jsonObject["caches"] as? JsonArray)
                ?: json.parseToJsonElement(resp) as? JsonArray
            val rows = arr?.mapNotNull { c ->
                val o = c as? JsonObject ?: return@mapNotNull null
                val code = o["code"]?.jsonPrimitive?.content ?: return@mapNotNull null
                GeocacheRow(
                    code = code,
                    name = o["name"]?.jsonPrimitive?.content ?: code,
                    type = o["type"]?.jsonPrimitive?.content ?: "traditional",
                    lat = o["lat"]?.jsonPrimitive?.doubleOrNull,
                    lon = o["lon"]?.jsonPrimitive?.doubleOrNull,
                    difficulty = o["difficulty"]?.jsonPrimitive?.doubleOrNull,
                    terrain = o["terrain"]?.jsonPrimitive?.doubleOrNull,
                    found = o["found"]?.jsonPrimitive?.booleanOrNull ?: false,
                )
            } ?: emptyList()
            if (rows.isNotEmpty()) db.map().upsertGeocaches(rows)
        }
        runCatching {
            val resp = hub.get("/meetup/events")
            val arr = (json.parseToJsonElement(resp).jsonObject["events"] as? JsonArray)
                ?: json.parseToJsonElement(resp) as? JsonArray
            val rows = arr?.mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                val id = o["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
                MeetupEventRow(
                    id = id,
                    title = o["title"]?.jsonPrimitive?.content ?: "(event)",
                    groupName = o["groupName"]?.jsonPrimitive?.content,
                    lat = o["lat"]?.jsonPrimitive?.doubleOrNull,
                    lon = o["lon"]?.jsonPrimitive?.doubleOrNull,
                    dateTime = o["dateTime"]?.jsonPrimitive?.longOrNull ?: 0L,
                    eventUrl = o["eventUrl"]?.jsonPrimitive?.content,
                )
            } ?: emptyList()
            if (rows.isNotEmpty()) {
                db.map().upsertMeetup(rows)
                db.map().deleteAbsentMeetup(rows.map { it.id }) // snapshot-authoritative
            }
        }
    }
}

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
    )

    private val _state = MutableStateFlow<NowPlaying?>(null)
    val state: StateFlow<NowPlaying?> = _state

    suspend fun refresh() {
        // GET /spotify/player returns the hub's SpotifyPlayerSnapshot
        // (server/src/spotify/types.ts): {linked, isPlaying, device, item
        // {name, artists: string, durationMs}, progressMs, ...} — the hub
        // already normalized Spotify's raw shape.
        val resp = runCatching { hub.get("/spotify/player") }.getOrNull() ?: return
        val obj = runCatching { json.parseToJsonElement(resp).jsonObject }.getOrNull() ?: return
        val snap = (obj["data"] as? JsonObject) ?: obj
        val item = snap["item"] as? JsonObject
        _state.value = NowPlaying(
            track = item?.get("name")?.jsonPrimitive?.content ?: "—",
            artist = item?.get("artists")?.jsonPrimitive?.content ?: "",
            isPlaying = snap["isPlaying"]?.jsonPrimitive?.booleanOrNull ?: false,
            progressMs = snap["progressMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            durationMs = item?.get("durationMs")?.jsonPrimitive?.longOrNull ?: 0L,
            device = (snap["device"] as? JsonObject)?.get("name")?.jsonPrimitive?.content,
            volumePercent = (snap["device"] as? JsonObject)?.get("volumePercent")?.jsonPrimitive?.content?.toIntOrNull(),
        )
    }

    suspend fun toggle() { runCatching { hub.post("/spotify/toggle") }; refresh() }
    suspend fun next() { runCatching { hub.post("/spotify/next") }; refresh() }
    suspend fun prev() { runCatching { hub.post("/spotify/previous") }; refresh() }
    suspend fun volume(pct: Int) { runCatching { hub.post("/spotify/volume", """{"percent":$pct}""") }; refresh() }
}

/** Home dashboard — last-known snapshot render; canvas is a WebView island. */
class HomeRepository(private val hub: HubClient) {
    data class Snapshot(val serversJson: String, val alertsJson: String, val fetchedAt: Long)

    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    val snapshot: StateFlow<Snapshot?> = _snapshot

    suspend fun refresh() {
        val servers = runCatching { hub.get("/dashboard/snapshot") }.getOrNull()
        val alerts = runCatching { hub.get("/dashboard/alerts") }.getOrNull()
        if (servers != null || alerts != null) {
            _snapshot.value = Snapshot(
                serversJson = servers ?: _snapshot.value?.serversJson ?: "{}",
                alertsJson = alerts ?: _snapshot.value?.alertsJson ?: "{}",
                fetchedAt = System.currentTimeMillis(),
            )
        }
    }
}
