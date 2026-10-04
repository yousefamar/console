package io.amar.console.data.gmaps

import io.amar.console.core.HubClient
import io.amar.console.data.longtail.GPlace
import io.amar.console.data.longtail.GSuggestion
import io.amar.console.data.longtail.LatLon
import io.amar.console.data.longtail.parseGmapsStatus
import io.amar.console.data.longtail.parsePlaceEnvelope
import io.amar.console.data.longtail.parseSuggestions
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Google Places over the hub's /gmaps/* proxy, shared by the Map screen and
// the calendar event form (port of src/utils/gmaps.ts). Holds no UI state:
// each consumer owns its own GmapsSession. The Cloud key never reaches the phone.

/** Places Autocomplete billing session: one token rides every keystroke's
 *  /autocomplete AND the /place details fetch that ends the run, so Google
 *  bills the run as one session. [GmapsClient.place] rotates it. */
class GmapsSession {
    private var token: String? = null
    fun token(): String = token ?: java.util.UUID.randomUUID().toString().also { token = it }
    fun reset() { token = null }
}

class GmapsClient(
    private val hub: HubClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var configured: Pair<Long, Boolean>? = null
    private var fix: Pair<Long, LatLon?>? = null

    /** Is a Maps Platform key configured on the hub? Cached 10 min; a failed
     *  probe (offline) answers false and is not cached. */
    suspend fun configured(): Boolean {
        configured?.let { (at, v) -> if (now() - at < CACHE_MS) return v }
        val v = runCatching { hub.get("/gmaps/status") }.getOrNull()?.let { parseGmapsStatus(it) } ?: return false
        configured = now() to v
        return v
    }

    /** Yousef's latest phone fix from the hub, for biasing suggestions when no
     *  map is on screen. Cached 10 min; null = unbiased (still works). */
    suspend fun lastKnownLocation(): LatLon? {
        fix?.let { (at, v) -> if (now() - at < CACHE_MS) return v }
        val v = runCatching { hub.get("/location") }.getOrNull()?.let { parseLocationFix(it) }
        fix = now() to v
        return v
    }

    /** Type-ahead suggestions for [input] (< 2 chars → none). Throws on a
     *  transport failure; callers decide whether that is an error. */
    suspend fun autocomplete(input: String, session: GmapsSession, bias: LatLon?): List<GSuggestion> {
        val q = input.trim()
        if (q.length < 2) return emptyList()
        val sb = StringBuilder("/gmaps/autocomplete?q=").append(enc(q)).append("&session=").append(session.token())
        if (bias != null) sb.append("&lat=").append(bias.lat).append("&lon=").append(bias.lon)
        return parseSuggestions(hub.get(sb.toString()))
    }

    /** Resolve a suggestion to a full place. Ends the billing session. */
    suspend fun place(placeId: String, session: GmapsSession): GPlace {
        val raw = hub.get("/gmaps/place/${enc(placeId)}?session=${session.token()}")
        session.reset()
        return parsePlaceEnvelope(raw) ?: throw IllegalStateException("place not found")
    }

    private companion object { const val CACHE_MS = 10 * 60_000L }
}

/** "Name, formatted address" the way Google Calendar fills its own location
 *  field — the address alone when it already starts with the name. */
fun placeLocationText(place: GPlace): String {
    val name = place.name
    val address = place.address
    if (address.isNullOrEmpty()) return name
    if (name.isEmpty() || address.lowercase().startsWith(name.lowercase())) return address
    return "$name, $address"
}

private val fixJson = Json { ignoreUnknownKeys = true }

/** `GET /location` → its `fix` {lat, lon}, null when absent or non-finite. */
fun parseLocationFix(raw: String): LatLon? = runCatching {
    val f = fixJson.parseToJsonElement(raw).jsonObject["fix"] as? JsonObject ?: return null
    val lat = f["lat"]?.jsonPrimitive?.doubleOrNull ?: return null
    val lon = f["lon"]?.jsonPrimitive?.doubleOrNull ?: return null
    if (!lat.isFinite() || !lon.isFinite()) null else LatLon(lat, lon)
}.getOrNull()

private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
