package io.amar.console.data.longtail

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Google Maps search + directions over the hub's /gmaps/* proxy — pure models,
// parsers and formatters (mirror of the gmaps slice in src/store/map.ts +
// gmapsDirUrl/fmtDuration/fmtDistance in MapTab.tsx). The Cloud key never
// reaches the phone; everything here is shape-only and JVM-testable.

private val gjson = Json { ignoreUnknownKeys = true }

/** Hub PlaceResult (server/src/gmaps/client.ts). */
data class GPlace(
    val id: String,
    val name: String,
    val address: String?,
    val lat: Double,
    val lon: Double,
    val types: List<String> = emptyList(),
    val rating: Double? = null,
    val userRatingCount: Int? = null,
    /** Google's own deep link — the richest "open in Google Maps" target. */
    val googleMapsUri: String? = null,
)

/** Hub PlaceSuggestion — one type-ahead row. */
data class GSuggestion(val placeId: String, val text: String, val mainText: String, val secondaryText: String?)

enum class GTravelMode(val param: String, val label: String) {
    DRIVE("driving", "Drive"), WALK("walking", "Walk"), BICYCLE("bicycling", "Cycle"), TRANSIT("transit", "Transit"),
}

/** Hub RouteResult; geometry is the GeoJSON LineString's [lon, lat] pairs. */
data class GRoute(
    val description: String?,
    val durationSec: Int,
    val distanceMeters: Int,
    val coordinates: List<Pair<Double, Double>>,
)

data class LatLon(val lat: Double, val lon: Double)

// --- parsers (hub JSON → models) ------------------------------------------- //

fun parseGmapsStatus(raw: String): Boolean? = runCatching {
    gjson.parseToJsonElement(raw).jsonObject["configured"]?.jsonPrimitive?.content == "true"
}.getOrNull()

fun parsePlaces(raw: String): List<GPlace> = runCatching {
    (gjson.parseToJsonElement(raw).jsonObject["results"] as? JsonArray)
        ?.mapNotNull { parsePlace(it as? JsonObject) } ?: emptyList()
}.getOrDefault(emptyList())

fun parsePlaceEnvelope(raw: String): GPlace? = runCatching {
    parsePlace(gjson.parseToJsonElement(raw).jsonObject["place"] as? JsonObject)
}.getOrNull()

fun parsePlace(o: JsonObject?): GPlace? {
    if (o == null) return null
    val id = o["id"]?.jsonPrimitive?.content ?: return null
    val lat = o["lat"]?.jsonPrimitive?.doubleOrNull ?: return null
    val lon = o["lon"]?.jsonPrimitive?.doubleOrNull ?: return null
    return GPlace(
        id = id,
        name = o["name"]?.jsonPrimitive?.content ?: id,
        address = o["address"]?.str(),
        lat = lat,
        lon = lon,
        types = (o["types"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
        rating = o["rating"]?.jsonPrimitive?.doubleOrNull,
        userRatingCount = o["userRatingCount"]?.jsonPrimitive?.intOrNull,
        googleMapsUri = o["googleMapsUri"]?.str(),
    )
}

fun parseSuggestions(raw: String): List<GSuggestion> = runCatching {
    (gjson.parseToJsonElement(raw).jsonObject["suggestions"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val id = o["placeId"]?.jsonPrimitive?.content ?: return@mapNotNull null
        val main = o["mainText"]?.jsonPrimitive?.content ?: o["text"]?.jsonPrimitive?.content ?: return@mapNotNull null
        GSuggestion(
            placeId = id,
            text = o["text"]?.jsonPrimitive?.content ?: main,
            mainText = main,
            secondaryText = o["secondaryText"]?.str(),
        )
    } ?: emptyList()
}.getOrDefault(emptyList())

fun parseRoutes(raw: String): List<GRoute> = runCatching {
    (gjson.parseToJsonElement(raw).jsonObject["routes"] as? JsonArray)?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val coords = (o["geometry"] as? JsonObject)?.get("coordinates")?.jsonArray?.mapNotNull { c ->
            val pair = c as? JsonArray ?: return@mapNotNull null
            if (pair.size < 2) return@mapNotNull null
            val lon = pair[0].jsonPrimitive.doubleOrNull ?: return@mapNotNull null
            val lat = pair[1].jsonPrimitive.doubleOrNull ?: return@mapNotNull null
            lon to lat
        } ?: emptyList()
        if (coords.size < 2) return@mapNotNull null
        GRoute(
            description = o["description"]?.str(),
            durationSec = o["durationSec"]?.jsonPrimitive?.doubleOrNull?.toInt() ?: 0,
            distanceMeters = o["distanceMeters"]?.jsonPrimitive?.doubleOrNull?.toInt() ?: 0,
            coordinates = coords,
        )
    } ?: emptyList()
}.getOrDefault(emptyList())

/** Body of a hub `{error}` envelope, else the raw text (HTTP failures). */
fun gmapsErrorText(raw: String?): String {
    if (raw.isNullOrBlank()) return "request failed"
    return runCatching { gjson.parseToJsonElement(raw).jsonObject["error"]?.jsonPrimitive?.content }
        .getOrNull() ?: raw.take(160)
}

// JsonNull is a JsonPrimitive whose content is "null" — treat it as absent.
private fun kotlinx.serialization.json.JsonElement.str(): String? =
    (this as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() && it != "null" }

// --- deep links + formatting (MapTab.tsx parity) ---------------------------- //

/** maps.google.com directions link — with an origin when known, else Google
 *  Maps starts from the device's own location. `destination_place_id` pins the
 *  exact place (Google's `places/` prefix stripped, as the SPA does). */
fun gmapsDirUrl(from: LatLon?, to: GPlace, mode: GTravelMode): String {
    val sb = StringBuilder("https://www.google.com/maps/dir/?api=1")
    sb.append("&destination=").append(enc("${to.lat},${to.lon}"))
    sb.append("&travelmode=").append(mode.param)
    if (to.id.isNotBlank()) sb.append("&destination_place_id=").append(enc(to.id.removePrefix("places/")))
    if (from != null) sb.append("&origin=").append(enc("${from.lat},${from.lon}"))
    return sb.toString()
}

fun fmtDuration(sec: Int): String {
    if (sec <= 0) return "—"
    val h = sec / 3600
    val m = Math.round((sec % 3600) / 60.0).toInt()
    if (h > 0) return "${h}h ${m}m"
    if (m > 0) return "$m min"
    return "${sec}s"
}

fun fmtDistance(m: Int): String {
    if (m <= 0) return ""
    if (m < 1000) return "$m m"
    val km = m / 1000.0
    return if (m < 10_000) "%.1f km".format(java.util.Locale.US, km) else "${Math.round(km)} km"
}

/** "★ 4.6 (1,234)" — null when the place has no rating. */
fun fmtRating(rating: Double?, count: Int?): String? {
    if (rating == null) return null
    val r = "%.1f".format(java.util.Locale.US, rating)
    return if (count != null && count > 0) "★ $r (${java.text.NumberFormat.getIntegerInstance(java.util.Locale.US).format(count)})" else "★ $r"
}

/** Human labels for Google place types: drop the generic bucket types, snake → spaces, at most [max]. */
fun placeTypeLabels(types: List<String>, max: Int = 3): List<String> =
    types.filter { it !in GENERIC_PLACE_TYPES }.map { it.replace('_', ' ') }.take(max)

private val GENERIC_PLACE_TYPES = setOf("point_of_interest", "establishment", "food", "store", "geocode", "premise", "political")

private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
