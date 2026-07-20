package io.amar.console.data.notes

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pure parser for the hub's pen-page SVGs (scratch/pen/<note>/page-<n>.svg).
 * The lossless PenPageDoc is embedded in <metadata><penpage>{json}</penpage>
 * (see server/src/pen/page-codec.ts renderPageSvg): strokes[].dots[]{x,y,f?,force?,t}
 * in Ncode units. We draw scaled polylines on a Canvas — no SVG lib needed.
 */
data class PenDot(val x: Float, val y: Float, val force: Float)
data class PenStroke(val dots: List<PenDot>)
data class PenPageDoc(
    val strokes: List<PenStroke>,
    // Fixed Pocket-Cahier page rect in Ncode units (mirrors the SPA renderer:
    // viewBox anchored at the crop offset, expanded only if writing exceeds it).
    val viewX: Float,
    val viewY: Float,
    val viewW: Float,
    val viewH: Float,
)

object PenPage {
    // Kept in sync with server/src/pen/page-codec.ts + PenPageRenderer.tsx.
    const val NCODE_PAGE_X0 = 6f
    const val NCODE_PAGE_Y0 = 5f
    const val NCODE_PAGE_W = 37.96f
    const val NCODE_PAGE_H = 59.06f
    private const val PAD = 0.5f

    private val json = Json { ignoreUnknownKeys = true }

    fun isPenPagePath(path: String): Boolean =
        path.startsWith("scratch/pen/") && path.endsWith(".svg")

    /** scratch/pen/<note>/page-<n>.svg → page number, else null. */
    fun pageNumber(path: String): Int? =
        Regex("""page-(\d+)\.svg$""").find(path)?.groupValues?.get(1)?.toIntOrNull()

    /** Parse the embedded penpage strokes out of a page SVG. Null when absent/foreign. */
    fun parse(svg: String): PenPageDoc? {
        val m = Regex("<penpage>([\\s\\S]*?)</penpage>").find(svg) ?: return null
        val doc = runCatching { json.parseToJsonElement(m.groupValues[1]).jsonObject }.getOrNull()
            ?: return null
        val strokes = (doc["strokes"] as? JsonArray)?.mapNotNull { s ->
            val obj = s as? JsonObject ?: return@mapNotNull null
            val dots = ((obj["dots"] ?: obj["points"]) as? JsonArray)?.mapNotNull { d ->
                val o = d as? JsonObject ?: return@mapNotNull null
                val x = o["x"]?.jsonPrimitive?.floatOrNull ?: return@mapNotNull null
                val y = o["y"]?.jsonPrimitive?.floatOrNull ?: return@mapNotNull null
                val f = (o["f"] ?: o["force"])?.jsonPrimitive?.floatOrNull ?: 0f
                PenDot(x, y, f)
            } ?: return@mapNotNull null
            if (dots.isEmpty()) null else PenStroke(dots)
        } ?: emptyList()
        return PenPageDoc(strokes = strokes, viewX = 0f, viewY = 0f, viewW = 0f, viewH = 0f)
            .withComputedBox()
    }

    /** Build a doc (with fixed page rect) directly from a stroke list — used
     *  for the live-overlay render where strokes come from SyncBus, not an SVG. */
    fun docFromStrokes(strokes: List<PenStroke>): PenPageDoc =
        PenPageDoc(strokes = strokes, viewX = 0f, viewY = 0f, viewW = 0f, viewH = 0f).withComputedBox()

    /** Fixed page rect anchored at the crop offset; expands only past the page edge. */
    private fun PenPageDoc.withComputedBox(): PenPageDoc {
        var minX = Float.POSITIVE_INFINITY
        var minY = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY
        for (s in strokes) for (d in s.dots) {
            if (d.x < minX) minX = d.x
            if (d.y < minY) minY = d.y
            if (d.x > maxX) maxX = d.x
            if (d.y > maxY) maxY = d.y
        }
        val x0 = minOf(NCODE_PAGE_X0, (if (minX.isFinite()) minX else NCODE_PAGE_X0) - PAD)
        val y0 = minOf(NCODE_PAGE_Y0, (if (minY.isFinite()) minY else NCODE_PAGE_Y0) - PAD)
        val x1 = maxOf(NCODE_PAGE_X0 + NCODE_PAGE_W, (if (maxX.isFinite()) maxX else 0f) + PAD)
        val y1 = maxOf(NCODE_PAGE_Y0 + NCODE_PAGE_H, (if (maxY.isFinite()) maxY else 0f) + PAD)
        return copy(viewX = x0, viewY = y0, viewW = x1 - x0, viewH = y1 - y0)
    }

    /**
     * Sibling pen pages of [path] within the same notebook dir, sorted by page
     * number — the prev/next nav walks this list.
     */
    fun siblingPages(path: String, allPaths: List<String>): List<String> {
        val dir = path.substringBeforeLast('/')
        return allPaths
            .filter { it.substringBeforeLast('/') == dir && pageNumber(it) != null }
            .sortedBy { pageNumber(it) }
    }
}
