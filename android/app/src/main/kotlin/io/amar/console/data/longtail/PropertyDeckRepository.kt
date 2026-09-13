package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import io.amar.console.data.db.OutboxRow
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.roundToInt

private val json = Json { ignoreUnknownKeys = true }

/** One card of GET /property/deck (server/src/property/deck.ts DeckCard). */
data class PropertyCard(
    val listingId: String,
    val searchId: String,
    val kind: String,
    val tier: String?,
    val portal: String,
    val alsoOn: List<String>,
    val country: String,
    val url: String,
    val title: String?,
    val address: String?,
    /** Major units in [currency]. */
    val price: Double?,
    val currency: String,
    val bedrooms: Int?,
    val bathrooms: Int?,
    val floorArea: Double?,
    val plotArea: Double?,
    val propertyType: String?,
    val tenure: String?,
    val listedAt: String?,
    val agent: String?,
    val image: String?,
    val summary: String?,
    val keyFeatures: List<String>,
    val description: String?,
    val fixer: Boolean,
    val highStreet: String?,
    val airport: String?,
    val lat: Double,
    val lon: Double,
) {
    /** Portal ids are unique only within a search. */
    val key: String get() = "$searchId/$listingId"
}

data class PropertyDeck(val cards: List<PropertyCard>, val total: Int, val counts: Map<String, Int>)

enum class Verdict(val wire: String) { Interested("interested"), Dismissed("dismissed") }

val PROPERTY_KINDS = listOf("house", "farmland", "plot")

fun kindLabel(kind: String): String = when (kind) {
    "house" -> "Houses"
    "farmland" -> "Land"
    "plot" -> "Plots"
    else -> kind
}

fun parsePropertyDeck(raw: String): PropertyDeck? {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    val cards = (obj["cards"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::parseCard) } ?: emptyList()
    val counts = (obj["counts"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.intOrNull?.let { k to it } }?.toMap() ?: emptyMap()
    return PropertyDeck(cards = cards, total = obj["total"]?.jsonPrimitive?.intOrNull ?: cards.size, counts = counts)
}

private fun parseCard(o: JsonObject): PropertyCard? {
    fun str(k: String): String? = (o[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    fun num(k: String): Double? = (o[k] as? JsonPrimitive)?.doubleOrNull
    fun int(k: String): Int? = (o[k] as? JsonPrimitive)?.intOrNull
    fun strs(k: String): List<String> = (o[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
    val listingId = str("listingId") ?: return null
    val searchId = str("searchId") ?: return null
    return PropertyCard(
        listingId = listingId,
        searchId = searchId,
        kind = str("kind") ?: "house",
        tier = str("tier"),
        portal = str("portal") ?: "",
        alsoOn = strs("alsoOn"),
        country = str("country") ?: "",
        url = str("url") ?: "",
        title = str("title"),
        address = str("address"),
        price = num("price"),
        currency = str("currency") ?: "GBP",
        bedrooms = int("bedrooms"),
        bathrooms = int("bathrooms"),
        floorArea = num("floorArea"),
        plotArea = num("plotArea"),
        propertyType = str("propertyType"),
        tenure = str("tenure"),
        listedAt = str("listedAt"),
        agent = str("agent"),
        image = str("image"),
        summary = str("summary"),
        keyFeatures = strs("keyFeatures"),
        description = str("description"),
        fixer = (o["fixer"] as? JsonPrimitive)?.booleanOrNull ?: false,
        highStreet = str("highStreet"),
        airport = str("airport"),
        lat = num("lat") ?: 0.0,
        lon = num("lon") ?: 0.0,
    )
}

// ---------------------------------------------------------------------- //
// Formatting (pure — unit-tested)

/** "£180,000" / "€200,000"; whole units, en-GB grouping like the pin popup. */
fun formatPrice(price: Double?, currency: String): String? {
    if (price == null) return null
    val symbol = when (currency) { "GBP" -> "£"; "EUR" -> "€"; else -> "" }
    val n = String.format(java.util.Locale.UK, "%,d", price.roundToInt())
    return if (symbol.isNotEmpty()) "$symbol$n" else "$n $currency"
}

/** m² up to a hectare, then "1.2 ha" for land. */
fun formatArea(m2: Double?, land: Boolean = false): String? {
    if (m2 == null || m2 <= 0) return null
    if (land && m2 >= 10_000) return String.format(java.util.Locale.UK, "%.1f ha", m2 / 10_000)
    return "${m2.roundToInt()} m²"
}

/** The one-line facts strip under the price: "3 bed · 2 bath · 120 m² · 1,200 m² plot · Detached · Freehold". */
fun factsLine(c: PropertyCard): String {
    val parts = mutableListOf<String>()
    c.bedrooms?.let { parts += "$it bed" }
    c.bathrooms?.let { parts += "$it bath" }
    formatArea(c.floorArea)?.let { parts += it }
    formatArea(c.plotArea, land = true)?.let { parts += "$it plot" }
    c.propertyType?.let { parts += it }
    c.tenure?.let { parts += it.replaceFirstChar { ch -> ch.uppercase() } }
    return parts.joinToString(" · ")
}

/** "today" / "3d ago" / "2w ago" / "3mo ago"; null when the portal exposes no date. */
fun listedAgo(iso: String?, nowMs: Long = System.currentTimeMillis()): String? {
    if (iso.isNullOrBlank()) return null
    val ms = runCatching { java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli() }
        .recoverCatching { java.time.LocalDate.parse(iso.take(10)).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli() }
        .getOrNull() ?: return null
    val days = ((nowMs - ms) / 86_400_000L).coerceAtLeast(0)
    return when {
        days == 0L -> "today"
        days < 14 -> "${days}d ago"
        days < 60 -> "${days / 7}w ago"
        else -> "${days / 30}mo ago"
    }
}

fun portalLabel(portal: String): String = when (portal) {
    "rightmove" -> "Rightmove"
    "onthemarket" -> "OnTheMarket"
    "immoscout24" -> "ImmoScout24"
    "immobiliare" -> "immobiliare.it"
    "sparkasse" -> "Sparkasse"
    "kleinanzeigen" -> "Kleinanzeigen"
    "wikicasa" -> "Wikicasa"
    "subito" -> "Subito"
    "smallholdings" -> "Smallholdings"
    else -> portal
}

// ---------------------------------------------------------------------- //
// Swipe geometry (pure — unit-tested)

/** Fraction of the card width the card must travel to commit a verdict. */
const val SWIPE_COMMIT_FRACTION = 0.35f
/** px/s — a quick flick commits even from a short drag. */
const val SWIPE_FLING_VELOCITY = 1800f

/** Right = interested, left = dismissed, null = spring back. */
fun swipeVerdict(offsetX: Float, velocityX: Float, widthPx: Float): Verdict? {
    val commit = widthPx * SWIPE_COMMIT_FRACTION
    val flung = abs(velocityX) >= SWIPE_FLING_VELOCITY && (velocityX > 0) == (offsetX > 0) && abs(offsetX) > widthPx * 0.08f
    return when {
        offsetX >= commit || (flung && offsetX > 0) -> Verdict.Interested
        offsetX <= -commit || (flung && offsetX < 0) -> Verdict.Dismissed
        else -> null
    }
}

// ---------------------------------------------------------------------- //
// Unreviewed count off the map layers (Map toolbar badge; SPA countUnreviewedListings parity)

private val LISTING_ID_RE = Regex("\"listingId\"\\s*:")
private val INTERESTED_RE = Regex("\"review\"\\s*:\\s*\"interested\"")

// Pins on a property layer that carry a listingId and no verdict. Counted by
// regex over the raw string, like emojiInGeojson — the house layer is ~6 MB and
// a kotlinx JsonElement tree of it OOMs the phone beside MapLibre's own parse
// (v96 crashed on every Map open). Both keys occur once per feature, only in
// property pins' properties.
fun countUnreviewedListings(geojson: String): Int {
    val listings = LISTING_ID_RE.findAll(geojson).count()
    if (listings == 0) return 0
    return (listings - INTERESTED_RE.findAll(geojson).count()).coerceAtLeast(0)
}

// ---------------------------------------------------------------------- //

data class PropertyDeckUiState(
    val kind: String = "house",
    /** Remaining stack, top card first. */
    val cards: List<PropertyCard> = emptyList(),
    /** Unreviewed of [kind] on the hub at last fetch, minus verdicts since. */
    val total: Int = 0,
    val counts: Map<String, Int> = emptyMap(),
    val loading: Boolean = false,
    val error: String? = null,
    /** Verdicts this session, oldest first — the undo stack. */
    val history: List<Pair<PropertyCard, Verdict>> = emptyList(),
)

/**
 * The swipe deck: a page of unreviewed pins from the hub, verdicts through
 * the outbox (a swipe on the train must not be lost), a local undo stack.
 * The hub keeps serving a card until its verdict lands, so ids judged this
 * session are filtered out of every page — the outbox may still be holding
 * them.
 */
class PropertyDeckRepository(private val hub: HubClient, private val outbox: Outbox) {
    private val _state = MutableStateFlow(PropertyDeckUiState())
    val state: StateFlow<PropertyDeckUiState> = _state

    private val judged = mutableSetOf<String>()

    companion object {
        const val TYPE_REVIEW = "propertyReview"
        const val PAGE = 40
        /** Server-side cap (DECK_MAX_LIMIT). */
        const val MAX_LIMIT = 200
        /** Fetch the next page when the stack runs this low. */
        const val REFILL_AT = 8
    }

    suspend fun load(kind: String = _state.value.kind) {
        _state.value = _state.value.copy(kind = kind, loading = true, error = null)
        try {
            val deck = parsePropertyDeck(hub.get("/property/deck?kind=${enc(kind)}&limit=$PAGE")) ?: error("bad deck payload")
            val fresh = deck.cards.filter { it.key !in judged }
            _state.value = _state.value.copy(
                cards = fresh,
                total = (deck.total - (deck.cards.size - fresh.size)).coerceAtLeast(fresh.size),
                counts = deck.counts,
                loading = false,
            )
        } catch (e: Exception) {
            _state.value = _state.value.copy(loading = false, error = e.message ?: "load failed")
        }
    }

    /** Append the next page behind the current stack (dedup by key). */
    private suspend fun refill() {
        val s = _state.value
        if (s.loading || s.cards.size >= s.total) return
        _state.value = s.copy(loading = true)
        try {
            // The hub still serves what we hold and what we've judged but not yet flushed — ask past both.
            val limit = minOf(PAGE + s.cards.size + judged.size, MAX_LIMIT)
            val deck = parsePropertyDeck(hub.get("/property/deck?kind=${enc(s.kind)}&limit=$limit")) ?: error("bad deck payload")
            val have = _state.value.cards.map { it.key }.toSet()
            val more = deck.cards.filter { it.key !in judged && it.key !in have }
            _state.value = _state.value.copy(cards = _state.value.cards + more, counts = deck.counts, loading = false)
        } catch (e: Exception) {
            _state.value = _state.value.copy(loading = false)
        }
    }

    /** Optimistic: the card leaves the stack now; the hub hears about it via the outbox. */
    suspend fun judge(card: PropertyCard, verdict: Verdict) {
        judged += card.key
        val s = _state.value
        _state.value = s.copy(
            cards = s.cards.filter { it.key != card.key },
            total = (s.total - 1).coerceAtLeast(0),
            counts = s.counts + (card.kind to ((s.counts[card.kind] ?: 1) - 1).coerceAtLeast(0)),
            history = (s.history + (card to verdict)).takeLast(50),
        )
        enqueue(card, verdict.wire)
        if (_state.value.cards.size < REFILL_AT) refill()
    }

    /** Put the last judged card back on top and clear its verdict on the hub. */
    suspend fun undo() {
        val s = _state.value
        val (card, _) = s.history.lastOrNull() ?: return
        judged -= card.key
        _state.value = s.copy(
            cards = listOf(card) + s.cards.filter { it.key != card.key },
            total = s.total + 1,
            counts = s.counts + (card.kind to (s.counts[card.kind] ?: 0) + 1),
            history = s.history.dropLast(1),
        )
        // A verdict still waiting in the outbox is simply withdrawn; one that
        // already landed is reverted by an explicit `none`.
        outbox.cancel(card.key, TYPE_REVIEW)
        enqueue(card, "none")
    }

    private suspend fun enqueue(card: PropertyCard, state: String) {
        outbox.enqueue(
            TYPE_REVIEW,
            buildJsonObject {
                put("searchId", card.searchId)
                put("listingId", card.listingId)
                put("state", state)
            }.toString(),
            entityId = card.key,
        )
    }

    fun registerOutboxHandlers() {
        outbox.register(TYPE_REVIEW) { row, _ -> handleReview(row) }
    }

    private suspend fun handleReview(row: OutboxRow): Outbox.Result {
        val p = json.parseToJsonElement(row.payloadJson).jsonObject
        return try {
            val searchId = p["searchId"]!!.jsonPrimitive.content
            hub.post(
                "/property/searches/${enc(searchId)}/review",
                buildJsonObject {
                    put("listingId", p["listingId"]!!.jsonPrimitive.content)
                    put("state", p["state"]!!.jsonPrimitive.content)
                }.toString(),
            )
            Outbox.Result.Done
        } catch (e: HubClient.HttpException) {
            when {
                e.code == 404 -> Outbox.Result.Done // search deleted since — nothing left to judge
                e.code in 400..499 -> Outbox.Result.Fail("HTTP ${e.code}")
                else -> Outbox.Result.Retry("HTTP ${e.code}")
            }
        } catch (e: Exception) {
            Outbox.retryOrNotReady(e, "network")
        }
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
