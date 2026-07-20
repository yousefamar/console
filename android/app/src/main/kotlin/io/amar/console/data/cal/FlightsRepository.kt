package io.amar.console.data.cal

import io.amar.console.core.HubClient
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Flight watchlists — hub-mirrored, no client polling (port of src/store/flights.ts).
 * The panel reads [watchlists] + [configured]; mutations go straight to the hub and
 * the SyncBus `flights` service (polled/created/updated/deleted) keeps the mirror live.
 */
class FlightsRepository(
    private val hub: HubClient,
    private val syncBus: SyncBusClient,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private val _watchlists = MutableStateFlow<List<Watchlist>>(emptyList())
    val watchlists: StateFlow<List<Watchlist>> = _watchlists

    private val _configured = MutableStateFlow<Boolean?>(null) // null = unknown
    val configured: StateFlow<Boolean?> = _configured

    private val _running = MutableStateFlow<Set<String>>(emptySet())
    val running: StateFlow<Set<String>> = _running

    @Volatile private var loaded = false

    // ---- Model ---------------------------------------------------------- //

    data class ResultRow(
        val label: String,
        val priceMajor: Double,
        val startDate: String?,
        val endDate: String?,
        val departureTime: String?,
        val arrivalTime: String?,
        val stops: Int?,
        val airlines: List<String>,
        val flightNumbers: List<String>,
        val totalDurationMin: Int?,
        val airport: String?,
        val country: String?,
        val link: String?,
    )

    data class Watchlist(
        val id: String,
        val label: String?,
        val kind: String,                    // explore | route
        val origin: String,
        val currency: String,
        val maxPriceMajor: Double?,
        val notifyOnDrop: Boolean,
        val region: String?,
        val destination: String?,
        val month: Int?,
        val duration: String?,
        val outboundDate: String?,
        val returnDate: String?,
        val travelClass: Int?,
        val adults: Int?,
        val lastCheckedAt: Long?,
        val lastError: String?,
        val lastPriceMajor: Double?,
        val history: List<Double>,           // priceMajor sequence (oldest→newest)
        val lastResults: List<ResultRow>,
    )

    // ---- Load + wire ---------------------------------------------------- //

    suspend fun init() {
        if (loaded) return
        loaded = true
        refresh()
        checkConfigured()
    }

    fun wireLiveDeltas() {
        syncBus.on("flights", "polled") { d -> upsertFromEvent(d) }
        syncBus.on("flights", "created") { d -> upsertFromEvent(d) }
        syncBus.on("flights", "updated") { d -> upsertFromEvent(d) }
        syncBus.on("flights", "deleted") { d ->
            val id = (d as? JsonObject)?.get("id")?.jsonPrimitive?.content ?: return@on
            _watchlists.value = _watchlists.value.filterNot { it.id == id }
        }
    }

    private fun upsertFromEvent(d: JsonElement) {
        val wl = (d as? JsonObject)?.let { parseWatchlist(it) } ?: return
        _watchlists.value = _watchlists.value.filterNot { it.id == wl.id } + wl
    }

    suspend fun refresh() {
        runCatching {
            val resp = hub.get("/flights/watchlists")
            val arr = json.parseToJsonElement(resp).jsonObject["watchlists"] as? JsonArray ?: return@runCatching
            _watchlists.value = arr.mapNotNull { (it as? JsonObject)?.let { o -> parseWatchlist(o) } }
        }
    }

    suspend fun checkConfigured() {
        _configured.value = runCatching {
            json.parseToJsonElement(hub.get("/flights/status")).jsonObject["configured"]?.jsonPrimitive?.booleanOrNull
        }.getOrNull() ?: false
    }

    suspend fun create(body: JsonObject) {
        runCatching {
            val resp = hub.post("/flights/watchlists", body.toString())
            parseWatchlist(json.parseToJsonElement(resp).jsonObject)
        }.getOrNull()?.let { wl -> _watchlists.value = _watchlists.value.filterNot { it.id == wl.id } + wl }
    }

    suspend fun remove(id: String) {
        runCatching { hub.delete("/flights/watchlists/$id") }
        _watchlists.value = _watchlists.value.filterNot { it.id == id }
    }

    suspend fun runOne(id: String) {
        _running.value = _running.value + id
        try {
            runCatching {
                val resp = hub.post("/flights/watchlists/$id/run")
                parseWatchlist(json.parseToJsonElement(resp).jsonObject)
            }.getOrNull()?.let { wl -> _watchlists.value = _watchlists.value.map { if (it.id == wl.id) wl else it } }
        } finally {
            _running.value = _running.value - id
        }
    }

    // ---- Parse ---------------------------------------------------------- //

    internal fun parseWatchlist(o: JsonObject): Watchlist? {
        val id = o["id"]?.jsonPrimitive?.content ?: return null
        return Watchlist(
            id = id,
            label = o["label"]?.jsonPrimitive?.content,
            kind = o["kind"]?.jsonPrimitive?.content ?: "route",
            origin = o["origin"]?.jsonPrimitive?.content ?: "",
            currency = o["currency"]?.jsonPrimitive?.content ?: "GBP",
            maxPriceMajor = o["maxPriceMajor"]?.jsonPrimitive?.doubleOrNull,
            notifyOnDrop = o["notifyOnDrop"]?.jsonPrimitive?.booleanOrNull ?: true,
            region = o["region"]?.jsonPrimitive?.content,
            destination = o["destination"]?.jsonPrimitive?.content,
            month = o["month"]?.jsonPrimitive?.intOrNull,
            duration = o["duration"]?.jsonPrimitive?.content,
            outboundDate = o["outboundDate"]?.jsonPrimitive?.content,
            returnDate = o["returnDate"]?.jsonPrimitive?.content,
            travelClass = o["travelClass"]?.jsonPrimitive?.intOrNull,
            adults = o["adults"]?.jsonPrimitive?.intOrNull,
            lastCheckedAt = o["lastCheckedAt"]?.jsonPrimitive?.longOrNull,
            lastError = o["lastError"]?.jsonPrimitive?.content,
            lastPriceMajor = o["lastPriceMajor"]?.jsonPrimitive?.doubleOrNull,
            history = (o["history"] as? JsonArray)?.mapNotNull {
                (it as? JsonObject)?.get("priceMajor")?.jsonPrimitive?.doubleOrNull
            } ?: emptyList(),
            lastResults = (o["lastResults"] as? JsonArray)?.mapNotNull { el ->
                (el as? JsonObject)?.let { r ->
                    ResultRow(
                        label = r["label"]?.jsonPrimitive?.content ?: "",
                        priceMajor = r["priceMajor"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                        startDate = r["startDate"]?.jsonPrimitive?.content,
                        endDate = r["endDate"]?.jsonPrimitive?.content,
                        departureTime = r["departureTime"]?.jsonPrimitive?.content,
                        arrivalTime = r["arrivalTime"]?.jsonPrimitive?.content,
                        stops = r["stops"]?.jsonPrimitive?.intOrNull,
                        airlines = (r["airlines"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList(),
                        flightNumbers = (r["flightNumbers"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList(),
                        totalDurationMin = r["totalDurationMin"]?.jsonPrimitive?.intOrNull,
                        airport = r["airport"]?.jsonPrimitive?.content,
                        country = r["country"]?.jsonPrimitive?.content,
                        link = r["link"]?.jsonPrimitive?.content,
                    )
                }
            } ?: emptyList(),
        )
    }
}
