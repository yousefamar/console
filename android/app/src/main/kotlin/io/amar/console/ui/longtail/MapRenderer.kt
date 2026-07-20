package io.amar.console.ui.longtail

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import io.amar.console.data.longtail.BuiltinLayer
import io.amar.console.data.longtail.MapCache
import io.amar.console.data.longtail.MapLayerMeta
import io.amar.console.data.longtail.MapUiState
import io.amar.console.data.longtail.MeetupEvent
import io.amar.console.data.longtail.OtFix
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.FillLayer
import org.maplibre.android.style.layers.Layer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource

/**
 * Imperative MapLibre glue — the Android analogue of MapTab.tsx's `pushSource`
 * / `addOverlayLayers` / `reconcileAgentLayers`. Owns all source/layer mutation
 * so the Compose layer stays declarative (it just calls `apply(state)`).
 *
 * Layer stack (bottom→top), mirroring the SPA ids:
 *   ot-track (line) · ot-current (circle) · agent layers ·
 *   gc-selected (ring) · gc-pins (emoji) · meetup-selected (ring) · meetup-pins
 */
class MapRenderer {
    private var style: Style? = null
    private var map: MapLibreMap? = null
    private val agentSlugs = mutableSetOf<String>()
    private val animatedLines = mutableSetOf<String>()

    // Geocache pin emoji by cache type (mirrors TYPE_EMOJI in MapTab.tsx).
    private val typeEmoji = mapOf(
        "Traditional" to "📦", "Multi-cache" to "🧩", "Mystery" to "❓",
        "Letterbox" to "✉️", "EarthCache" to "🌍", "Event" to "🎉",
        "Mega-Event" to "🎉", "Giga-Event" to "🎉", "Community Celebration" to "🎉",
        "HQ Block Party" to "🎉", "HQ Celebration" to "🎉",
        "Cache In Trash Out Event" to "♻️", "Webcam" to "📷", "Virtual" to "🔮",
        "Wherigo" to "🕹️", "GPS Adventures Exhibit" to "🧭", "Geocaching HQ" to "🏢",
        "Locationless" to "🌐", "Project APE" to "🦍",
    )

    fun attach(map: MapLibreMap, style: Style) {
        this.map = map
        this.style = style
        // Pre-register the fixed emoji set used by geocache/meetup pins.
        val fixed = (typeEmoji.values + listOf("📦", "😀", "😟", "📅")).toSet()
        for (e in fixed) ensureEmojiImage(e)
        addBaseOverlays(style)
    }

    fun detach() {
        style = null
        map = null
        agentSlugs.clear()
        animatedLines.clear()
    }

    // --- emoji → bitmap image (colour glyph, on demand) --------------------- //

    private fun ensureEmojiImage(emoji: String) {
        val s = style ?: return
        val id = "em:$emoji"
        if (s.getImage(id) != null) return
        val px = 64
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = px * 0.8f
            textAlign = Paint.Align.CENTER
        }
        val fm = paint.fontMetrics
        val y = px / 2f - (fm.ascent + fm.descent) / 2f
        canvas.drawText(emoji, px / 2f, y, paint)
        s.addImage(id, bmp)
    }

    // --- base overlay sources + layers -------------------------------------- //

    private fun addBaseOverlays(s: Style) {
        if (s.getSource("ot-track") == null) {
            s.addSource(GeoJsonSource("ot-track", emptyFc()))
            s.addLayer(
                LineLayer("ot-track", "ot-track").withProperties(
                    PropertyFactory.lineColor("#38bdf8"),
                    PropertyFactory.lineWidth(3f),
                    PropertyFactory.lineOpacity(0.8f),
                    PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                    PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
                ),
            )
        }
        if (s.getSource("ot-current") == null) {
            s.addSource(GeoJsonSource("ot-current", emptyFc()))
            s.addLayer(
                CircleLayer("ot-current", "ot-current").withProperties(
                    PropertyFactory.circleRadius(7f),
                    PropertyFactory.circleColor("#3b82f6"),
                    PropertyFactory.circleStrokeWidth(2f),
                    PropertyFactory.circleStrokeColor("#ffffff"),
                ),
            )
        }
        if (s.getSource("gc-pins") == null) {
            s.addSource(GeoJsonSource("gc-pins", emptyFc()))
            s.addLayer(
                CircleLayer("gc-selected", "gc-pins").apply {
                    setFilter(Expression.eq(Expression.get("code"), Expression.literal("")))
                }.withProperties(
                    PropertyFactory.circleRadius(16f),
                    PropertyFactory.circleColor("rgba(56,189,248,0.18)"),
                    PropertyFactory.circleStrokeWidth(2f),
                    PropertyFactory.circleStrokeColor("#ffffff"),
                ),
            )
            s.addLayer(
                SymbolLayer("gc-pins", "gc-pins").withProperties(
                    PropertyFactory.iconImage(pinEmojiExpr()),
                    PropertyFactory.iconSize(0.6f),
                    PropertyFactory.iconAllowOverlap(true),
                    PropertyFactory.iconIgnorePlacement(true),
                ),
            )
        }
        if (s.getSource("meetup-pins") == null) {
            s.addSource(GeoJsonSource("meetup-pins", emptyFc()))
            s.addLayer(
                CircleLayer("meetup-selected", "meetup-pins").apply {
                    setFilter(Expression.eq(Expression.get("id"), Expression.literal("")))
                }.withProperties(
                    PropertyFactory.circleRadius(16f),
                    PropertyFactory.circleColor("rgba(255,74,121,0.25)"),
                    PropertyFactory.circleStrokeWidth(2f),
                    PropertyFactory.circleStrokeColor("#ffffff"),
                ),
            )
            s.addLayer(
                SymbolLayer("meetup-pins", "meetup-pins").withProperties(
                    PropertyFactory.iconImage("em:📅"),
                    PropertyFactory.iconSize(0.6f),
                    PropertyFactory.iconAllowOverlap(true),
                    PropertyFactory.iconIgnorePlacement(true),
                ),
            )
        }
    }

    /** case found→😀, dnf→😟, else match(type)→emoji, default 📍. */
    private fun pinEmojiExpr(): Expression {
        val stops = typeEmoji.map { (type, emoji) ->
            Expression.stop(type, Expression.literal("em:$emoji"))
        }.toTypedArray()
        val byType = Expression.match(
            Expression.get("type"),
            Expression.literal("em:📍"),
            *stops,
        )
        return Expression.switchCase(
            Expression.eq(Expression.get("found"), Expression.literal(1L)), Expression.literal("em:😀"),
            Expression.eq(Expression.get("dnf"), Expression.literal(1L)), Expression.literal("em:😟"),
            byType,
        )
    }

    // --- push state → sources ----------------------------------------------- //

    fun apply(state: MapUiState) {
        val s = style ?: return
        (s.getSourceAs<GeoJsonSource>("gc-pins"))?.setGeoJson(pinsFc(state.pins))
        (s.getSourceAs<GeoJsonSource>("meetup-pins"))?.setGeoJson(eventsFc(state.events))
        (s.getSourceAs<GeoJsonSource>("ot-track"))?.setGeoJson(trackFc(state.track))
        (s.getSourceAs<GeoJsonSource>("ot-current"))?.setGeoJson(currentFc(state.current))
        (s.getLayer("gc-selected"))?.setFilter(
            Expression.eq(Expression.get("code"), Expression.literal(state.selectedCode ?: "")),
        )
        (s.getLayer("meetup-selected"))?.setFilter(
            Expression.eq(Expression.get("id"), Expression.literal(state.selectedEventId ?: "")),
        )
        applyBuiltinVisibility(state.builtinVisible)
        reconcileAgentLayers(state)
    }

    private fun Layer?.setFilter(f: Expression) {
        when (this) {
            is CircleLayer -> setFilter(f)
            is SymbolLayer -> setFilter(f)
            is LineLayer -> setFilter(f)
            is FillLayer -> setFilter(f)
            else -> {}
        }
    }

    // --- built-in visibility ------------------------------------------------- //

    private val builtinSublayers = mapOf(
        BuiltinLayer.LOCATION to listOf("ot-track", "ot-current"),
        BuiltinLayer.GEOCACHES to listOf("gc-selected", "gc-pins"),
        BuiltinLayer.MEETUP to listOf("meetup-selected", "meetup-pins"),
    )

    private fun applyBuiltinVisibility(visible: Map<BuiltinLayer, Boolean>) {
        val s = style ?: return
        for ((id, sublayers) in builtinSublayers) {
            val v = if (visible[id] == false) Property.NONE else Property.VISIBLE
            for (sl in sublayers) s.getLayer(sl)?.setProperties(PropertyFactory.visibility(v))
        }
    }

    // --- agent layers -------------------------------------------------------- //

    private fun reconcileAgentLayers(state: MapUiState) {
        val s = style ?: return
        val desired = state.layers.filter { state.layerVisible[it.slug] != false && state.layerData[it.slug] != null }
        val want = desired.map { it.slug }.toSet()
        // Remove layers no longer desired.
        for (slug in agentSlugs.toList()) {
            if (slug !in want) removeAgentLayer(slug)
        }
        for (l in desired) addOrUpdateAgentLayer(s, l, state.layerData[l.slug]!!)
    }

    private fun subIds(slug: String): List<String> {
        val b = "layer:$slug"
        return listOf("$b:fill", "$b:line", "$b:circle", "$b:symbol", "$b:label")
    }

    private fun removeAgentLayer(slug: String) {
        val s = style ?: return
        val b = "layer:$slug"
        animatedLines.remove("$b:line")
        for (id in subIds(slug)) s.getLayer(id)?.let { s.removeLayer(id) }
        s.getSource(b)?.let { s.removeSource(b) }
        agentSlugs.remove(slug)
    }

    private fun addOrUpdateAgentLayer(s: Style, meta: MapLayerMeta, geojson: String) {
        val srcId = "layer:${meta.slug}"
        val existing = s.getSourceAs<GeoJsonSource>(srcId)
        if (existing != null) { existing.setGeoJson(geojson); return }
        // Extract any emoji used as _icon so styleimagemissing-equivalent works.
        for (e in emojiInGeojson(geojson)) ensureEmojiImage(e)

        s.addSource(GeoJsonSource(srcId, geojson))
        val st = meta.style
        val below = if (s.getLayer("gc-selected") != null) "gc-selected" else null
        val (fill, line, circle, symbol, label) = subIds(meta.slug)

        // Polygon-only fill (guards against MapLibre auto-closing LineStrings).
        val fillLayer = FillLayer(fill, srcId).apply {
            setFilter(Expression.eq(Expression.geometryType(), Expression.literal("Polygon")))
        }.withProperties(
            PropertyFactory.fillColor(st.fillColor ?: "#3b82f6"),
            PropertyFactory.fillOpacity((st.fillOpacity ?: 0.15).toFloat()),
        )
        val lineProps = mutableListOf(
            PropertyFactory.lineColor(
                Expression.coalesce(Expression.get("_color"), Expression.literal(st.strokeColor ?: st.lineColor ?: "#3b82f6")),
            ),
            PropertyFactory.lineWidth((st.strokeWidth ?: st.lineWidth ?: 1.5).toFloat()),
            PropertyFactory.lineCap(if (st.animated) Property.LINE_CAP_BUTT else Property.LINE_CAP_ROUND),
            PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
        )
        if (st.animated) lineProps.add(PropertyFactory.lineDasharray(arrayOf(0f, 4f, 3f)))
        val lineLayer = LineLayer(line, srcId).withProperties(*lineProps.toTypedArray())
        val circleLayer = CircleLayer(circle, srcId).apply {
            setFilter(
                Expression.all(
                    Expression.eq(Expression.geometryType(), Expression.literal("Point")),
                    Expression.not(Expression.has("_icon")),
                ),
            )
        }.withProperties(
            PropertyFactory.circleColor(
                Expression.coalesce(Expression.get("_color"), Expression.literal(st.color ?: "#22c55e")),
            ),
            PropertyFactory.circleRadius(
                Expression.coalesce(Expression.get("_size"), Expression.literal((st.size ?: 5.0))),
            ),
            PropertyFactory.circleStrokeWidth(1f),
            PropertyFactory.circleStrokeColor("#0a0a0a"),
        )
        val symbolLayer = SymbolLayer(symbol, srcId).apply {
            setFilter(
                Expression.all(
                    Expression.eq(Expression.geometryType(), Expression.literal("Point")),
                    Expression.has("_icon"),
                ),
            )
        }.withProperties(
            PropertyFactory.iconImage(Expression.concat(Expression.literal("em:"), Expression.get("_icon"))),
            PropertyFactory.iconSize(0.7f),
            PropertyFactory.iconAllowOverlap(true),
            PropertyFactory.iconIgnorePlacement(true),
        )
        val labelLayer = SymbolLayer(label, srcId).apply {
            setFilter(
                Expression.all(
                    Expression.eq(Expression.geometryType(), Expression.literal("Point")),
                    Expression.has("_label"),
                ),
            )
        }.withProperties(
            PropertyFactory.textField(Expression.get("_label")),
            PropertyFactory.textFont(arrayOf("Noto Sans Regular")),
            PropertyFactory.textSize(12f),
            PropertyFactory.textOffset(arrayOf(0f, 0.6f)),
            PropertyFactory.textAnchor(Property.TEXT_ANCHOR_TOP),
            PropertyFactory.textColor(Expression.coalesce(Expression.get("_color"), Expression.literal("#a5f3fc"))),
            PropertyFactory.textHaloColor("#04141a"),
            PropertyFactory.textHaloWidth(1.8f),
        )
        for (layer in listOf(fillLayer, lineLayer, circleLayer, symbolLayer, labelLayer)) {
            if (below != null) s.addLayerBelow(layer, below) else s.addLayer(layer)
        }
        if (st.animated) animatedLines.add(line)
        agentSlugs.add(meta.slug)
    }

    /** Advance every animated agent line to the given dash frame. */
    fun stepDash(frame: Array<Float>) {
        val s = style ?: return
        for (id in animatedLines) {
            (s.getLayer(id) as? LineLayer)?.setProperties(PropertyFactory.lineDasharray(frame))
        }
    }

    fun hasAnimatedLines(): Boolean = animatedLines.isNotEmpty()

    // --- fit-to-bbox --------------------------------------------------------- //

    fun fitBounds(bbox: List<Double>) {
        val m = map ?: return
        if (bbox.size != 4) return
        val (w, s, e, n) = bbox
        val bounds = LatLngBounds.from(n, e, s, w)
        runCatching {
            m.easeCamera(
                org.maplibre.android.camera.CameraUpdateFactory.newLatLngBounds(bounds, 40),
                600,
            )
        }
    }

    companion object {
        fun emptyFc(): String = """{"type":"FeatureCollection","features":[]}"""
    }
}

// destructuring for List<Double>/List<String>
private operator fun <T> List<T>.component4(): T = this[3]
private operator fun <T> List<T>.component5(): T = this[4]

// --- pure feature-collection builders (JVM-testable) ---------------------- //

fun pinsFc(pins: List<MapCache>): String {
    val feats = pins.filter { it.lat != null && it.lon != null }.joinToString(",") { p ->
        """{"type":"Feature","geometry":{"type":"Point","coordinates":[${p.lon},${p.lat}]},""" +
            """"properties":{"code":${jsonStr(p.code)},"type":${jsonStr(p.type)},"found":${if (p.found) 1 else 0},"dnf":${if (p.dnf) 1 else 0}}}"""
    }
    return """{"type":"FeatureCollection","features":[$feats]}"""
}

fun eventsFc(events: List<MeetupEvent>): String {
    val feats = events.filter { it.lat != null && it.lon != null }.joinToString(",") { e ->
        """{"type":"Feature","geometry":{"type":"Point","coordinates":[${e.lon},${e.lat}]},"properties":{"id":${jsonStr(e.id)}}}"""
    }
    return """{"type":"FeatureCollection","features":[$feats]}"""
}

fun trackFc(track: List<OtFix>): String {
    if (track.size < 2) return MapRenderer.emptyFc()
    val coords = track.joinToString(",") { "[${it.lon},${it.lat}]" }
    return """{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[$coords]},"properties":{}}]}"""
}

fun currentFc(current: List<OtFix>): String {
    val feats = current.joinToString(",") { f ->
        """{"type":"Feature","geometry":{"type":"Point","coordinates":[${f.lon},${f.lat}]},"properties":{"device":${jsonStr(f.device ?: "")}}}"""
    }
    return """{"type":"FeatureCollection","features":[$feats]}"""
}

/** Minimal JSON string escaper for embedding property values. */
fun jsonStr(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) when (c) {
        '\\' -> sb.append("\\\\")
        '"' -> sb.append("\\\"")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
    }
    return sb.append("\"").toString()
}

/** Collect the distinct emoji used as `_icon` in a raw GeoJSON string, so the
 *  renderer can rasterise them before the symbol layer references them. */
fun emojiInGeojson(geojson: String): Set<String> {
    val out = mutableSetOf<String>()
    val re = Regex("\"_icon\"\\s*:\\s*\"([^\"]+)\"")
    for (m in re.findAll(geojson)) out.add(m.groupValues[1])
    return out
}
