package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.GeocacheRow
import io.amar.console.data.db.MeetupEventRow
import io.amar.console.data.db.MetaRow
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

private val json = Json { ignoreUnknownKeys = true }

// ---------------------------------------------------------------------- //
// Domain models — mirror of src/store/map.ts (richer than the Room rows,
// which hold only the offline-pin subset).

data class OtFix(
    val lat: Double,
    val lon: Double,
    val tst: Long, // unix seconds
    val device: String?,
    val acc: Double? = null,
    val batt: Int? = null,
)

data class GcAttribute(val slug: String, val label: String, val enabled: Boolean)
data class GcLog(val id: String, val type: String, val text: String, val date: String, val author: String)
data class GcDetail(
    val hint: String,
    val description: String,
    val attributes: List<GcAttribute>,
    val logs: List<GcLog>,
    val fetchedAt: Long,
)

data class MapCache(
    val code: String,
    val name: String,
    val lat: Double?,
    val lon: Double?,
    val type: String,
    val size: String,
    val difficulty: Double,
    val terrain: Double,
    val found: Boolean,
    val dnf: Boolean,
    val pmOnly: Boolean,
    val owner: String,
    val hidden: String,
    val favorites: Int,
    val status: String,
    val detail: GcDetail? = null,
)

data class MeetupDetail(val description: String, val fetchedAt: Long)
data class MeetupEvent(
    val id: String,
    val title: String,
    val dateTime: String, // ISO 8601 with offset
    val endTime: String,
    val eventUrl: String,
    val eventType: String, // PHYSICAL | ONLINE | HYBRID
    val isOnline: Boolean,
    val going: Int,
    val groupName: String,
    val groupUrlname: String,
    val venueName: String,
    val venueAddress: String,
    val venueCity: String,
    val lat: Double?,
    val lon: Double?,
    val detail: MeetupDetail? = null,
)

data class Budget(val used: Int, val cap: Int, val remaining: Int)
data class GcStatus(
    val loggedIn: Boolean,
    val username: String?,
    val hasCredentials: Boolean,
    val budget: Budget?,
    val cacheCount: Int,
)
data class MeetupStatus(val budget: Budget?, val eventCount: Int, val lastFetch: Long)

data class MapLayerStyle(
    val color: String? = null,
    val size: Double? = null,
    val fillColor: String? = null,
    val fillOpacity: Double? = null,
    val strokeColor: String? = null,
    val strokeWidth: Double? = null,
    val lineColor: String? = null,
    val lineWidth: Double? = null,
    val animated: Boolean = false,
    /** Ordered popup fields: each is a key (optionally with a display label). */
    val popup: List<Pair<String, String>> = emptyList(),
)

data class MapLayerMeta(
    val slug: String,
    val group: String,
    val name: String,
    val geometryTypes: List<String>,
    val featureCount: Int,
    val bbox: List<Double>?, // [w, s, e, n]
    val style: MapLayerStyle,
    val fit: Boolean,
    val updatedAt: Long,
    val updatedBy: String?,
)

enum class BuiltinLayer { LOCATION, GEOCACHES, MEETUP }

/**
 * Full map state: OwnTracks history + geocache/meetup pins with lazy detail +
 * agent-authored GeoJSON layers + per-layer visibility. Offline-first: pins,
 * events, and layers hydrate from Room / meta-KV so the map renders without the
 * hub (only the CARTO basemap tiles need the network). All hub calls tolerate
 * failure, keeping the last-known data.
 */
data class MapUiState(
    // OwnTracks
    val current: List<OtFix> = emptyList(),
    val devices: List<String> = emptyList(),
    val device: String? = null,
    val track: List<OtFix> = emptyList(),
    val rangeFrom: Long = System.currentTimeMillis() - DAY_MS,
    val rangeTo: Long = System.currentTimeMillis(),
    val loadingHistory: Boolean = false,

    // Geocaches
    val pins: List<MapCache> = emptyList(),
    val selectedCode: String? = null,
    val gcStatus: GcStatus? = null,
    val fetching: Boolean = false,

    // Meetup
    val events: List<MeetupEvent> = emptyList(),
    val selectedEventId: String? = null,
    val meetupStatus: MeetupStatus? = null,
    val fetchingMeetup: Boolean = false,
    val meetupDays: Int = 0, // 0 = upcoming (no end bound)

    // Agent layers
    val layers: List<MapLayerMeta> = emptyList(),
    val layerData: Map<String, String> = emptyMap(), // slug → raw geojson string
    val layerVisible: Map<String, Boolean> = emptyMap(),

    // Built-in visibility (default all-on)
    val builtinVisible: Map<BuiltinLayer, Boolean> = mapOf(
        BuiltinLayer.LOCATION to true,
        BuiltinLayer.GEOCACHES to true,
        BuiltinLayer.MEETUP to true,
    ),

    val error: String? = null,
) {
    companion object { const val DAY_MS = 24L * 60 * 60 * 1000 }
}

const val MAX_TRACK_POINTS = 4000
private const val OT_USER = "amar"
private const val LAYER_INDEX_KEY = "console:mapLayerIndex:v1"
private const val LAYER_DATA_PREFIX = "console:mapLayer:"
private const val BUILTIN_VIS_KEY = "console:map:builtinVisible"
private const val LAYER_VIS_KEY = "console:map:layerVisible"

class MapRepository(private val db: ConsoleDb, private val hub: HubClient) {
    private val _state = MutableStateFlow(MapUiState())
    val state: StateFlow<MapUiState> = _state

    private var prefsLoaded = false

    // --- offline hydration + prefs (called once from the screen on mount) --- //

    suspend fun hydrate() {
        loadPrefs()
        hydratePinsFromDb()
        hydrateEventsFromDb()
        hydrateLayersFromDb()
    }

    private suspend fun loadPrefs() {
        if (prefsLoaded) return
        prefsLoaded = true
        runCatching {
            db.meta().get(BUILTIN_VIS_KEY)?.let { raw ->
                val o = json.parseToJsonElement(raw).jsonObject
                val bv = _state.value.builtinVisible.toMutableMap()
                o["location"]?.jsonPrimitive?.booleanOrNull?.let { bv[BuiltinLayer.LOCATION] = it }
                o["geocaches"]?.jsonPrimitive?.booleanOrNull?.let { bv[BuiltinLayer.GEOCACHES] = it }
                o["meetup"]?.jsonPrimitive?.booleanOrNull?.let { bv[BuiltinLayer.MEETUP] = it }
                _state.value = _state.value.copy(builtinVisible = bv)
            }
        }
        runCatching {
            db.meta().get(LAYER_VIS_KEY)?.let { raw ->
                val o = json.parseToJsonElement(raw).jsonObject
                val lv = o.mapValues { it.value.jsonPrimitive.booleanOrNull ?: true }
                _state.value = _state.value.copy(layerVisible = lv)
            }
        }
    }

    private suspend fun hydratePinsFromDb() {
        val rows = runCatching { db.map().geocaches() }.getOrNull() ?: return
        if (rows.isEmpty()) return
        mergePins(rows.map { it.toMapCache() })
    }

    private suspend fun hydrateEventsFromDb() {
        val rows = runCatching { db.map().upcomingMeetup(System.currentTimeMillis()) }.getOrNull() ?: return
        if (rows.isEmpty()) return
        mergeEvents(rows.map { it.toMeetupEvent() })
    }

    private suspend fun hydrateLayersFromDb() {
        runCatching {
            val raw = db.meta().get(LAYER_INDEX_KEY) ?: return
            val metas = parseLayerIndex(raw)
            val data = mutableMapOf<String, String>()
            for (m in metas) db.meta().get(LAYER_DATA_PREFIX + m.slug)?.let { data[m.slug] = it }
            _state.value = _state.value.copy(layers = metas, layerData = _state.value.layerData + data)
        }
    }

    // --- combined status + snapshot refresh (owntracks + gc + meetup) ------- //

    /** Wired into SyncEngine's "map" domain (runs on every hub connect) AND
     *  called by the screen on mount. Mirrors src/store/map.ts refresh(). */
    suspend fun reconcile() {
        val last = runCatching { hub.get("/owntracks/last") }.getOrNull()?.let { parseFixes(it) } ?: emptyList()
        val gc = runCatching { hub.get("/geocaching/status") }.getOrNull()?.let { parseGcStatus(it) }
        val mu = runCatching { hub.get("/meetup/status") }.getOrNull()?.let { parseMeetupStatus(it) }

        val devices = last.mapNotNull { it.device }.distinct()
        val cur = _state.value
        _state.value = cur.copy(
            current = last,
            devices = devices,
            device = if (cur.device != null && devices.contains(cur.device)) cur.device else devices.firstOrNull(),
            gcStatus = gc ?: cur.gcStatus,
            meetupStatus = mu ?: cur.meetupStatus,
        )
        loadPins()
        loadEvents()
        loadLayers()
    }

    /**
     * Live cross-device deltas: a fetch-area on the PC broadcasts over SyncBus,
     * and the phone's map updates without waiting for a reconnect. Mirrors the
     * SPA subscribers (geocaching/subscribe.ts, meetup/subscribe.ts,
     * map/layers-subscribe.ts). Call once at graph build time.
     */
    fun wireLiveDeltas(scope: CoroutineScope, syncBus: SyncBusClient) {
        syncBus.on("geocaching", "delta") { data ->
            val caches = ((data as? JsonObject)?.get("caches") as? JsonArray)
                ?.mapNotNull { it as? JsonObject }?.mapNotNull { parseCache(it) } ?: return@on
            if (caches.isNotEmpty()) {
                mergePins(caches)
                scope.launch { persistPins(caches) }
            }
        }
        syncBus.on("meetup", "delta") { data ->
            val events = ((data as? JsonObject)?.get("events") as? JsonArray)
                ?.mapNotNull { it as? JsonObject }?.mapNotNull { parseEvent(it) } ?: return@on
            if (events.isNotEmpty()) {
                mergeEvents(events)
                scope.launch { persistEvents(events) }
            }
        }
        syncBus.on("map-layers", "delta") { data ->
            val metas = (data as? JsonObject)?.let { parseLayerIndex(it.toString()) } ?: return@on
            scope.launch { applyLayerIndex(metas) }
        }
    }

    // --- OwnTracks history --------------------------------------------------- //

    /** Fetch OwnTracks history for [from]..[to] (inclusive end day), decimated
     *  to MAX_TRACK_POINTS. Mirrors loadHistory in the store. */
    suspend fun loadHistory(fromMs: Long? = null, toMs: Long? = null, device: String? = null) {
        val s = _state.value
        val from = fromMs ?: s.rangeFrom
        val to = toMs ?: s.rangeTo
        val dev = device ?: s.device ?: s.devices.firstOrNull() ?: return
        _state.value = s.copy(loadingHistory = true, rangeFrom = from, rangeTo = to, device = dev, error = null)
        try {
            val q = "user=$OT_USER&device=${enc(dev)}&from=${ymd(from)}&to=${ymd(to + MapUiState.DAY_MS)}&format=json"
            val resp = hub.get("/owntracks/locations?$q")
            val fixes = parseFixes(resp).sortedBy { it.tst }
            _state.value = _state.value.copy(track = decimate(fixes, MAX_TRACK_POINTS), loadingHistory = false)
        } catch (e: Exception) {
            _state.value = _state.value.copy(loadingHistory = false, error = e.message)
        }
    }

    fun setRange(fromMs: Long, toMs: Long) {
        _state.value = _state.value.copy(rangeFrom = fromMs, rangeTo = toMs)
    }

    // --- geocaches ----------------------------------------------------------- //

    suspend fun loadPins() {
        try {
            val resp = hub.get("/geocaching/caches")
            val caches = parseCaches(resp)
            mergePins(caches)
            persistPins(caches)
        } catch (e: Exception) {
            // offline — Room-hydrated pins remain.
            _state.value = _state.value.copy(error = e.message)
        }
    }

    /** Merge incoming summaries into pins, preserving locally-loaded detail. */
    fun mergePins(incoming: List<MapCache>) {
        val byCode = LinkedHashMap<String, MapCache>()
        for (p in _state.value.pins) byCode[p.code] = p
        for (c in incoming) {
            val prev = byCode[c.code]
            byCode[c.code] = if (prev?.detail != null && c.detail == null) c.copy(detail = prev.detail) else c
        }
        _state.value = _state.value.copy(pins = byCode.values.toList())
    }

    suspend fun fetchArea(bbox: List<Double>, max: Int? = null) {
        _state.value = _state.value.copy(fetching = true, error = null)
        try {
            val body = buildJsonObject {
                put("bbox", json.parseToJsonElement("[${bbox.joinToString(",")}]"))
                if (max != null) put("max", max)
            }.toString()
            val resp = hub.post("/geocaching/fetch-area", body)
            parseBudget(json.parseToJsonElement(resp).jsonObject["budget"])?.let { b ->
                _state.value = _state.value.gcStatus?.let { st ->
                    _state.value.copy(gcStatus = st.copy(budget = b))
                } ?: _state.value
            }
            loadPins()
        } catch (e: Exception) {
            _state.value = _state.value.copy(error = e.message)
        } finally {
            _state.value = _state.value.copy(fetching = false)
        }
    }

    /** Select a cache and lazily fetch its detail (once). */
    suspend fun selectCache(code: String?) {
        _state.value = _state.value.copy(selectedCode = code, selectedEventId = null)
        if (code == null) return
        val existing = _state.value.pins.find { it.code == code }
        if (existing?.detail != null) return
        try {
            val resp = hub.get("/geocaching/cache/${enc(code)}")
            val full = parseCache(json.parseToJsonElement(resp).jsonObject) ?: return
            _state.value = _state.value.copy(
                pins = _state.value.pins.map { if (it.code == code) full else it },
            )
        } catch (e: Exception) {
            _state.value = _state.value.copy(error = e.message)
        }
    }

    suspend fun setCredentials(username: String?, password: String?, cookie: String?) {
        _state.value = _state.value.copy(error = null)
        val body = buildJsonObject {
            if (!cookie.isNullOrBlank()) put("cookie", cookie)
            else { put("username", username ?: ""); put("password", password ?: "") }
        }.toString()
        // Let exceptions propagate so the panel shows the busy→error transition;
        // but also stash the message in state for the toolbar pill.
        try {
            val resp = hub.post("/geocaching/credentials", body)
            parseGcStatus(resp)?.let { _state.value = _state.value.copy(gcStatus = it) }
        } catch (e: Exception) {
            _state.value = _state.value.copy(error = e.message)
            throw e
        }
    }

    // --- meetup -------------------------------------------------------------- //

    suspend fun loadEvents() {
        try {
            val resp = hub.get("/meetup/events")
            val events = parseEvents(resp)
            mergeEvents(events)
            persistEvents(events)
        } catch (e: Exception) {
            _state.value = _state.value.copy(error = e.message)
        }
    }

    fun mergeEvents(incoming: List<MeetupEvent>) {
        val byId = LinkedHashMap<String, MeetupEvent>()
        for (e in _state.value.events) byId[e.id] = e
        for (ev in incoming) {
            val prev = byId[ev.id]
            byId[ev.id] = if (prev?.detail != null && ev.detail == null) ev.copy(detail = prev.detail) else ev
        }
        _state.value = _state.value.copy(events = byId.values.toList())
    }

    suspend fun fetchMeetupArea(bbox: List<Double>) {
        _state.value = _state.value.copy(fetchingMeetup = true, error = null)
        try {
            val days = _state.value.meetupDays
            val body = buildJsonObject {
                put("bbox", json.parseToJsonElement("[${bbox.joinToString(",")}]"))
                if (days > 0) put("days", days)
            }.toString()
            val resp = hub.post("/meetup/fetch-area", body)
            parseBudget(json.parseToJsonElement(resp).jsonObject["budget"])?.let { b ->
                _state.value = _state.value.meetupStatus?.let { st ->
                    _state.value.copy(meetupStatus = st.copy(budget = b))
                } ?: _state.value
            }
            loadEvents()
        } catch (e: Exception) {
            _state.value = _state.value.copy(error = e.message)
        } finally {
            _state.value = _state.value.copy(fetchingMeetup = false)
        }
    }

    suspend fun selectEvent(id: String?) {
        _state.value = _state.value.copy(selectedEventId = id, selectedCode = null)
        if (id == null) return
        val existing = _state.value.events.find { it.id == id }
        if (existing?.detail != null) return
        try {
            val resp = hub.get("/meetup/event/${enc(id)}")
            val full = parseEvent(json.parseToJsonElement(resp).jsonObject) ?: return
            _state.value = _state.value.copy(
                events = _state.value.events.map { if (it.id == id) full else it },
            )
        } catch (e: Exception) {
            _state.value = _state.value.copy(error = e.message)
        }
    }

    fun setMeetupDays(days: Int) { _state.value = _state.value.copy(meetupDays = days) }

    // --- agent layers -------------------------------------------------------- //

    suspend fun loadLayers() {
        try {
            val metas = parseLayerIndex(hub.get("/map/layers"))
            applyLayerIndex(metas)
        } catch (e: Exception) {
            // offline — meta-KV-hydrated layers remain.
        }
    }

    /** Apply a fresh layer index: cache it, drop stale geojson, re-fetch each
     *  layer's GeoJSON only when its slug is new or updatedAt changed. */
    private suspend fun applyLayerIndex(metas: List<MapLayerMeta>) {
        val prevByslug = _state.value.layers.associateBy { it.slug } // capture BEFORE overwrite
        _state.value = _state.value.copy(layers = metas)
        runCatching { db.meta().put(MetaRow(LAYER_INDEX_KEY, layerIndexToJson(metas))) }
        val slugs = metas.map { it.slug }.toSet()
        val stale = _state.value.layerData.keys.filter { it !in slugs }
        for (s in stale) runCatching { db.meta().delete(LAYER_DATA_PREFIX + s) }
        val newData = _state.value.layerData.filterKeys { it in slugs }.toMutableMap()
        for (m in metas) {
            // Keep cached geojson when updatedAt is unchanged (multi-MB layers).
            if (newData[m.slug] != null && prevByslug[m.slug]?.updatedAt == m.updatedAt) continue
            runCatching {
                val gj = hub.get("/map/layers/${enc(m.slug)}")
                newData[m.slug] = gj
                db.meta().put(MetaRow(LAYER_DATA_PREFIX + m.slug, gj))
            } // a failing layer is skipped, keeping any cached copy
        }
        _state.value = _state.value.copy(layerData = newData)
    }

    // --- visibility (persisted to meta KV, mirroring localStorage) ----------- //

    suspend fun toggleBuiltin(id: BuiltinLayer) {
        val bv = _state.value.builtinVisible.toMutableMap()
        bv[id] = !(bv[id] ?: true)
        _state.value = _state.value.copy(builtinVisible = bv)
        runCatching {
            db.meta().put(MetaRow(BUILTIN_VIS_KEY, buildJsonObject {
                put("location", bv[BuiltinLayer.LOCATION] ?: true)
                put("geocaches", bv[BuiltinLayer.GEOCACHES] ?: true)
                put("meetup", bv[BuiltinLayer.MEETUP] ?: true)
            }.toString()))
        }
    }

    suspend fun toggleLayer(slug: String) {
        val lv = _state.value.layerVisible.toMutableMap()
        val visible = lv[slug] != false
        lv[slug] = !visible
        _state.value = _state.value.copy(layerVisible = lv)
        persistLayerVis(lv)
    }

    suspend fun setGroupVisible(group: String, visible: Boolean) {
        val lv = _state.value.layerVisible.toMutableMap()
        for (l in _state.value.layers) if (l.group == group || l.slug == group) lv[l.slug] = visible
        _state.value = _state.value.copy(layerVisible = lv)
        persistLayerVis(lv)
    }

    private suspend fun persistLayerVis(lv: Map<String, Boolean>) {
        runCatching {
            db.meta().put(MetaRow(LAYER_VIS_KEY, buildJsonObject {
                for ((k, v) in lv) put(k, v)
            }.toString()))
        }
    }

    fun clearError() { _state.value = _state.value.copy(error = null) }

    // --- Room persistence (offline pins/events survive hub outage) ---------- //

    private suspend fun persistPins(caches: List<MapCache>) {
        val rows = caches.map {
            GeocacheRow(it.code, it.name, it.type, it.lat, it.lon, it.difficulty, it.terrain, it.found)
        }
        if (rows.isNotEmpty()) runCatching { db.map().upsertGeocaches(rows) }
    }

    private suspend fun persistEvents(events: List<MeetupEvent>) {
        val rows = events.map {
            MeetupEventRow(it.id, it.title, it.groupName, it.lat, it.lon, isoToEpochMs(it.dateTime), it.eventUrl)
        }
        if (rows.isNotEmpty()) runCatching {
            db.map().upsertMeetup(rows)
            db.map().deleteAbsentMeetup(rows.map { r -> r.id }) // snapshot-authoritative
        }
    }
}

// ---------------------------------------------------------------------- //
// Pure helpers (JVM-only, unit-testable).

/** UTC-agnostic yyyy-MM-dd in the device's local zone (mirrors JS `new Date`). */
fun ymd(ms: Long): String {
    val d = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
    return "%04d-%02d-%02d".format(d.year, d.monthValue, d.dayOfMonth)
}

/** Even-sample down to [max] items, always keeping the last. */
fun <T> decimate(arr: List<T>, max: Int): List<T> {
    if (arr.size <= max) return arr
    val step = arr.size.toDouble() / max
    val out = ArrayList<T>(max + 1)
    var i = 0.0
    while (i < arr.size) {
        out.add(arr[i.toInt()])
        i += step
    }
    val last = arr.last()
    if (out.isEmpty() || out.last() != last) out.add(last)
    return out
}

private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

/** ISO 8601 (with offset) → epoch ms; 0 on failure. */
fun isoToEpochMs(iso: String): Long =
    runCatching { java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()
        ?: runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()
        ?: 0L

fun parseBudget(el: kotlinx.serialization.json.JsonElement?): Budget? {
    val o = el as? JsonObject ?: return null
    return Budget(
        used = o["used"]?.jsonPrimitive?.intOrNull ?: 0,
        cap = o["cap"]?.jsonPrimitive?.intOrNull ?: 0,
        remaining = o["remaining"]?.jsonPrimitive?.intOrNull ?: 0,
    )
}

fun parseGcStatus(raw: String): GcStatus? = runCatching {
    val o = json.parseToJsonElement(raw).jsonObject
    GcStatus(
        loggedIn = o["loggedIn"]?.jsonPrimitive?.booleanOrNull ?: false,
        username = o["username"]?.jsonPrimitive?.contentOrNullSafe(),
        hasCredentials = o["hasCredentials"]?.jsonPrimitive?.booleanOrNull ?: false,
        budget = parseBudget(o["budget"]),
        cacheCount = o["cacheCount"]?.jsonPrimitive?.intOrNull ?: 0,
    )
}.getOrNull()

fun parseMeetupStatus(raw: String): MeetupStatus? = runCatching {
    val o = json.parseToJsonElement(raw).jsonObject
    MeetupStatus(
        budget = parseBudget(o["budget"]),
        eventCount = o["eventCount"]?.jsonPrimitive?.intOrNull ?: 0,
        lastFetch = o["lastFetch"]?.jsonPrimitive?.longOrNull ?: 0L,
    )
}.getOrNull()

fun parseFixes(raw: String): List<OtFix> {
    val el = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
    val arr = (el as? JsonArray) ?: (el as? JsonObject)?.get("data") as? JsonArray ?: return emptyList()
    return arr.mapNotNull { it as? JsonObject }.mapNotNull { o ->
        val lat = o["lat"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
        val lon = o["lon"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
        OtFix(
            lat = lat,
            lon = lon,
            tst = o["tst"]?.jsonPrimitive?.longOrNull ?: 0L,
            device = o["device"]?.jsonPrimitive?.contentOrNullSafe()
                ?: o["tid"]?.jsonPrimitive?.contentOrNullSafe()
                ?: (o["topic"]?.jsonPrimitive?.contentOrNullSafe()?.substringAfterLast('/')),
            acc = o["acc"]?.jsonPrimitive?.doubleOrNull,
            batt = o["batt"]?.jsonPrimitive?.intOrNull,
        )
    }
}

fun parseCaches(raw: String): List<MapCache> {
    val el = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
    val arr = ((el as? JsonObject)?.get("caches") as? JsonArray) ?: (el as? JsonArray) ?: return emptyList()
    return arr.mapNotNull { it as? JsonObject }.mapNotNull { parseCache(it) }
}

fun parseCache(o: JsonObject): MapCache? {
    val code = o["code"]?.jsonPrimitive?.contentOrNullSafe() ?: return null
    return MapCache(
        code = code,
        name = o["name"]?.jsonPrimitive?.contentOrNullSafe() ?: code,
        lat = o["lat"]?.jsonPrimitive?.doubleOrNull,
        lon = o["lon"]?.jsonPrimitive?.doubleOrNull,
        type = o["type"]?.jsonPrimitive?.contentOrNullSafe() ?: "Traditional",
        size = o["size"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        difficulty = o["difficulty"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        terrain = o["terrain"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        found = o["found"]?.jsonPrimitive?.booleanOrNull ?: false,
        dnf = o["dnf"]?.jsonPrimitive?.booleanOrNull ?: false,
        pmOnly = o["pmOnly"]?.jsonPrimitive?.booleanOrNull ?: false,
        owner = o["owner"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        hidden = o["hidden"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        favorites = o["favorites"]?.jsonPrimitive?.intOrNull ?: 0,
        status = o["status"]?.jsonPrimitive?.contentOrNullSafe() ?: "enabled",
        detail = (o["detail"] as? JsonObject)?.let { d ->
            GcDetail(
                hint = d["hint"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                description = d["description"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                attributes = (d["attributes"] as? JsonArray)?.mapNotNull { a ->
                    val ao = a as? JsonObject ?: return@mapNotNull null
                    GcAttribute(
                        slug = ao["slug"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                        label = ao["label"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                        enabled = ao["enabled"]?.jsonPrimitive?.booleanOrNull ?: false,
                    )
                } ?: emptyList(),
                logs = (d["logs"] as? JsonArray)?.mapNotNull { l ->
                    val lo = l as? JsonObject ?: return@mapNotNull null
                    GcLog(
                        id = lo["id"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                        type = lo["type"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                        text = lo["text"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                        date = lo["date"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                        author = lo["author"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                    )
                } ?: emptyList(),
                fetchedAt = d["fetchedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
        },
    )
}

fun parseEvents(raw: String): List<MeetupEvent> {
    val el = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
    val arr = ((el as? JsonObject)?.get("events") as? JsonArray) ?: (el as? JsonArray) ?: return emptyList()
    return arr.mapNotNull { it as? JsonObject }.mapNotNull { parseEvent(it) }
}

fun parseEvent(o: JsonObject): MeetupEvent? {
    val id = o["id"]?.jsonPrimitive?.contentOrNullSafe() ?: return null
    return MeetupEvent(
        id = id,
        title = o["title"]?.jsonPrimitive?.contentOrNullSafe() ?: "(event)",
        dateTime = o["dateTime"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        endTime = o["endTime"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        eventUrl = o["eventUrl"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        eventType = o["eventType"]?.jsonPrimitive?.contentOrNullSafe() ?: "PHYSICAL",
        isOnline = o["isOnline"]?.jsonPrimitive?.booleanOrNull ?: false,
        going = o["going"]?.jsonPrimitive?.intOrNull ?: 0,
        groupName = o["groupName"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        groupUrlname = o["groupUrlname"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        venueName = o["venueName"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        venueAddress = o["venueAddress"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        venueCity = o["venueCity"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
        lat = o["lat"]?.jsonPrimitive?.doubleOrNull,
        lon = o["lon"]?.jsonPrimitive?.doubleOrNull,
        detail = (o["detail"] as? JsonObject)?.let { d ->
            MeetupDetail(
                description = d["description"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
                fetchedAt = d["fetchedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
        },
    )
}

fun parseLayerIndex(raw: String): List<MapLayerMeta> {
    val el = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
    val arr = ((el as? JsonObject)?.get("layers") as? JsonArray) ?: (el as? JsonArray) ?: return emptyList()
    return arr.mapNotNull { it as? JsonObject }.mapNotNull { o ->
        val slug = o["slug"]?.jsonPrimitive?.contentOrNullSafe() ?: return@mapNotNull null
        MapLayerMeta(
            slug = slug,
            group = o["group"]?.jsonPrimitive?.contentOrNullSafe() ?: "",
            name = o["name"]?.jsonPrimitive?.contentOrNullSafe() ?: slug,
            geometryTypes = (o["geometryTypes"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNullSafe() } ?: emptyList(),
            featureCount = o["featureCount"]?.jsonPrimitive?.intOrNull ?: 0,
            bbox = (o["bbox"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.doubleOrNull }?.takeIf { it.size == 4 },
            style = parseLayerStyle(o["style"] as? JsonObject),
            fit = o["fit"]?.jsonPrimitive?.booleanOrNull ?: false,
            updatedAt = o["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
            updatedBy = o["updatedBy"]?.jsonPrimitive?.contentOrNullSafe(),
        )
    }
}

private fun parseLayerStyle(o: JsonObject?): MapLayerStyle {
    if (o == null) return MapLayerStyle()
    val popup = (o["popup"] as? JsonArray)?.mapNotNull { el ->
        when (el) {
            is JsonObject -> {
                val key = el["key"]?.jsonPrimitive?.contentOrNullSafe() ?: return@mapNotNull null
                key to (el["label"]?.jsonPrimitive?.contentOrNullSafe() ?: key)
            }
            else -> el.jsonPrimitive.contentOrNullSafe()?.let { it to it }
        }
    } ?: emptyList()
    return MapLayerStyle(
        color = o["color"]?.jsonPrimitive?.contentOrNullSafe(),
        size = o["size"]?.jsonPrimitive?.doubleOrNull,
        fillColor = o["fillColor"]?.jsonPrimitive?.contentOrNullSafe(),
        fillOpacity = o["fillOpacity"]?.jsonPrimitive?.doubleOrNull,
        strokeColor = o["strokeColor"]?.jsonPrimitive?.contentOrNullSafe(),
        strokeWidth = o["strokeWidth"]?.jsonPrimitive?.doubleOrNull,
        lineColor = o["lineColor"]?.jsonPrimitive?.contentOrNullSafe(),
        lineWidth = o["lineWidth"]?.jsonPrimitive?.doubleOrNull,
        animated = o["animated"]?.jsonPrimitive?.booleanOrNull ?: false,
        popup = popup,
    )
}

/** Re-serialise the index to JSON for the meta-KV cache (round-trips through
 *  parseLayerIndex). */
private fun layerIndexToJson(metas: List<MapLayerMeta>): String {
    val arr = kotlinx.serialization.json.buildJsonArray {
        for (m in metas) add(buildJsonObject {
            put("slug", m.slug); put("group", m.group); put("name", m.name)
            put("geometryTypes", kotlinx.serialization.json.buildJsonArray { for (t in m.geometryTypes) add(kotlinx.serialization.json.JsonPrimitive(t)) })
            put("featureCount", m.featureCount)
            m.bbox?.let { bb -> put("bbox", kotlinx.serialization.json.buildJsonArray { for (v in bb) add(kotlinx.serialization.json.JsonPrimitive(v)) }) }
            put("style", styleToJson(m.style))
            put("fit", m.fit); put("updatedAt", m.updatedAt)
            m.updatedBy?.let { put("updatedBy", it) }
        })
    }
    return arr.toString()
}

private fun styleToJson(s: MapLayerStyle) = buildJsonObject {
    s.color?.let { put("color", it) }
    s.size?.let { put("size", it) }
    s.fillColor?.let { put("fillColor", it) }
    s.fillOpacity?.let { put("fillOpacity", it) }
    s.strokeColor?.let { put("strokeColor", it) }
    s.strokeWidth?.let { put("strokeWidth", it) }
    s.lineColor?.let { put("lineColor", it) }
    s.lineWidth?.let { put("lineWidth", it) }
    if (s.animated) put("animated", true)
    if (s.popup.isNotEmpty()) put("popup", kotlinx.serialization.json.buildJsonArray {
        for ((k, label) in s.popup) add(buildJsonObject { put("key", k); put("label", label) })
    })
}

private fun GeocacheRow.toMapCache() = MapCache(
    code = code, name = name, lat = lat, lon = lon, type = type,
    size = "", difficulty = difficulty ?: 0.0, terrain = terrain ?: 0.0,
    found = found, dnf = false, pmOnly = false, owner = "", hidden = "", favorites = 0, status = "enabled",
)

private fun MeetupEventRow.toMeetupEvent() = MeetupEvent(
    id = id, title = title, dateTime = "", endTime = "", eventUrl = eventUrl ?: "",
    eventType = "PHYSICAL", isOnline = false, going = 0, groupName = groupName ?: "",
    groupUrlname = "", venueName = "", venueAddress = "", venueCity = "", lat = lat, lon = lon,
)

/** JsonPrimitive.content is "" for JsonNull → treat null literals as absent. */
private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? {
    if (this is kotlinx.serialization.json.JsonNull) return null
    val c = content
    return c.ifEmpty { null }
}
