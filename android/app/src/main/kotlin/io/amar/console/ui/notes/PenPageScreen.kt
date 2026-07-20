package io.amar.console.ui.notes

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.PenDot
import io.amar.console.data.notes.PenPage
import io.amar.console.data.notes.PenPageDoc
import io.amar.console.data.notes.PenStroke
import io.amar.console.data.notes.NotesRepository
import androidx.compose.runtime.withFrameNanos
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pen-page viewer with a LIVE handwriting overlay. Renders the durable SVG's
 * embedded strokes, then overlays live strokes streamed over the SyncBus 'pen'
 * service (stroke_delta / stroke_end / page_open) filtered to THIS note+page,
 * batched per frame. On page_saved the durable SVG is re-read and the overlay
 * cleared. Ribbon widths track pen pressure; foreign SVGs (no embedded strokes)
 * render in a white card. (src/components/notes/PenPageRenderer.tsx)
 */
@Composable
fun PenPageScreen(repo: NotesRepository, initialPath: String, onBack: () -> Unit) {
    val files by repo.observeFiles().collectAsState(initial = emptyList())
    var path by remember { mutableStateOf(initialPath) }
    var base by remember { mutableStateOf<List<PenStroke>>(emptyList()) }
    var foreignSvg by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }

    // Live overlay strokes (mutable, committed to state per frame).
    val liveRef = remember { mutableListOf<MutableList<PenDot>>() }
    var live by remember { mutableStateOf<List<PenStroke>>(emptyList()) }

    val addr = remember(path) { addrFromPath(path) }

    // Load/refresh the durable page on open + switch.
    LaunchedEffect(path) {
        loaded = false
        liveRef.clear(); live = emptyList()
        // Show cached instantly, then fetch the freshest durable SVG.
        val cached = repo.openFile(path)
        applySvg(cached) { b, f -> base = b; foreignSvg = f }
        val fresh = repo.fetchFreshBody(path)
        if (fresh != null) applySvg(fresh) { b, f -> base = b; foreignSvg = f }
        loaded = true
    }

    // Live SyncBus overlay — only for numeric notebook folders.
    LaunchedEffect(addr) {
        if (addr == null) return@LaunchedEffect
        var dirty = false
        val off = mutableListOf<() -> Unit>()
        fun mine(d: kotlinx.serialization.json.JsonElement?): Boolean {
            val o = d as? JsonObject ?: return false
            return o["note"]?.jsonPrimitive?.intOrNull == addr.first && o["page"]?.jsonPrimitive?.intOrNull == addr.second
        }
        off += repo.penBus("stroke_delta") { d ->
            if (!mine(d)) return@penBus
            val dots = parseDots((d as JsonObject)["dots"] as? JsonArray)
            var cur = liveRef.lastOrNull()
            if (cur == null) { cur = mutableListOf(); liveRef.add(cur) }
            cur.addAll(dots)
            dirty = true
        }
        off += repo.penBus("stroke_end") { d -> if (mine(d)) liveRef.add(mutableListOf()) }
        off += repo.penBus("page_open") { d ->
            if (!mine(d)) return@penBus
            val strokes = parseStrokesArray((d as JsonObject)["strokes"] as? JsonArray)
            if (strokes != null) base = strokes
            liveRef.clear(); live = emptyList(); dirty = true
        }
        off += repo.penBus("page_saved") { d ->
            if (!mine(d)) return@penBus
            // Re-read durable SVG (now includes what we drew live) + clear overlay.
            repo.penReload(path) { svg -> applySvg(svg) { b, f -> base = b; foreignSvg = f }; liveRef.clear(); live = emptyList(); dirty = true }
        }
        // rAF-style batching loop.
        try {
            while (true) {
                withFrameNanos { }
                if (dirty) {
                    live = liveRef.map { PenStroke(it.toList()) }
                    dirty = false
                }
            }
        } finally {
            off.forEach { it() }
        }
    }

    val siblings = remember(files, path) { PenPage.siblingPages(path, files.map { it.path }) }
    val index = siblings.indexOf(path)
    val label = remember(path) {
        val note = path.substringBeforeLast('/').substringAfterLast('/')
        val page = PenPage.pageNumber(path)
        if (page != null) "$note · page $page" else path.substringAfterLast('/')
    }

    val all = remember(base, live) { base + live }
    val doc = remember(all) { PenPage.docFromStrokes(all) }
    val empty = all.all { it.dots.isEmpty() }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Icon(Icons.Filled.Edit, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                label,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f).padding(start = 6.dp),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            IconButton(onClick = { if (index > 0) path = siblings[index - 1] }, enabled = index > 0) {
                Icon(Icons.Filled.ChevronLeft, "Previous page")
            }
            IconButton(onClick = { if (index in 0 until siblings.size - 1) path = siblings[index + 1] }, enabled = index in 0 until siblings.size - 1) {
                Icon(Icons.Filled.ChevronRight, "Next page")
            }
        }
        Box(Modifier.fillMaxSize().padding(8.dp), contentAlignment = Alignment.Center) {
            when {
                !loaded && base.isEmpty() && foreignSvg == null ->
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                empty && foreignSvg != null ->
                    // Foreign export (no embedded strokes to draw on Canvas):
                    // render the SVG verbatim via coil-svg inside a WHITE card so
                    // black ink reads against the dark theme.
                    androidx.compose.material3.Surface(
                        color = Color.White,
                        shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth().padding(4.dp),
                    ) {
                        coil.compose.AsyncImage(
                            model = coil.request.ImageRequest.Builder(androidx.compose.ui.platform.LocalContext.current)
                                .data(foreignSvg!!.toByteArray())
                                .decoderFactory(coil.decode.SvgDecoder.Factory())
                                .build(),
                            contentDescription = "Imported pen page",
                            contentScale = androidx.compose.ui.layout.ContentScale.Fit,
                            modifier = Modifier.fillMaxWidth().padding(8.dp),
                        )
                    }
                empty ->
                    Text("Waiting for strokes — start writing on this page.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                else -> RibbonCanvas(doc, base.size, Modifier.fillMaxSize())
            }
        }
    }
}

/** scratch/pen/<note>/page-<page>.svg → (note, page) for numeric notebooks. */
private fun addrFromPath(path: String): Pair<Int, Int>? {
    val m = Regex("""scratch/pen/(\d+)/page-(\d+)\.svg$""").find(path) ?: return null
    return m.groupValues[1].toInt() to m.groupValues[2].toInt()
}

private val penJson = Json { ignoreUnknownKeys = true }

private fun applySvg(svg: String?, set: (List<PenStroke>, String?) -> Unit) {
    svg ?: return set(emptyList(), null)
    val doc = PenPage.parse(svg)
    if (doc != null) set(doc.strokes, null)
    else if (svg.contains("<svg") && !svg.contains("<penpage>")) set(emptyList(), svg)
    else set(emptyList(), null)
}

private fun parseDots(arr: JsonArray?): List<PenDot> {
    arr ?: return emptyList()
    return arr.mapNotNull { d ->
        val o = d as? JsonObject ?: return@mapNotNull null
        val x = o["x"]?.jsonPrimitive?.floatOrNull ?: return@mapNotNull null
        val y = o["y"]?.jsonPrimitive?.floatOrNull ?: return@mapNotNull null
        val f = (o["f"] ?: o["force"])?.jsonPrimitive?.floatOrNull ?: 0f
        PenDot(x, y, f)
    }
}

private fun parseStrokesArray(arr: JsonArray?): List<PenStroke>? {
    arr ?: return null
    return arr.mapNotNull { s ->
        val o = s as? JsonObject ?: return@mapNotNull null
        val dots = parseDots((o["dots"] ?: o["points"]) as? JsonArray)
        if (dots.isEmpty()) null else PenStroke(dots)
    }
}

/**
 * Variable-width ribbon strokes (pressure-weighted) on a cream page, matching
 * the SPA renderer's forceToWidth / strokeRibbonPath. Base strokes and live
 * overlay both drawn dark on cream.
 */
@Composable
private fun RibbonCanvas(doc: PenPageDoc, baseCount: Int, modifier: Modifier = Modifier) {
    Canvas(modifier.background(Color(0xFFFAF9F5))) {
        if (doc.viewW <= 0f || doc.viewH <= 0f) return@Canvas
        val scale = minOf(size.width / doc.viewW, size.height / doc.viewH)
        val offX = (size.width - doc.viewW * scale) / 2f
        val offY = (size.height - doc.viewH * scale) / 2f
        fun tx(x: Float) = offX + (x - doc.viewX) * scale
        fun ty(y: Float) = offY + (y - doc.viewY) * scale

        for (stroke in doc.strokes) {
            val p = ribbonPath(stroke, scale, ::tx, ::ty) ?: continue
            drawPath(p, Color(0xFF111111))
        }
    }
}

private const val FORCE_REF = 480f
private const val W_MIN = 0.06f
private const val W_MAX = 0.18f

private fun forceToWidth(force: Float): Float {
    val t = (force / FORCE_REF).coerceIn(0f, 1f)
    return W_MIN + t * (W_MAX - W_MIN)
}

/** Build a filled variable-width outline in screen space (Ncode units × scale). */
private fun ribbonPath(s: PenStroke, scale: Float, tx: (Float) -> Float, ty: (Float) -> Float): Path? {
    val pts = s.dots
    if (pts.isEmpty()) return null
    val path = Path()
    if (pts.size == 1) {
        val r = forceToWidth(pts[0].force) / 2f * scale
        val cx = tx(pts[0].x); val cy = ty(pts[0].y)
        path.addOval(androidx.compose.ui.geometry.Rect(cx - r, cy - r, cx + r, cy + r))
        return path
    }
    val n = pts.size
    val left = ArrayList<Offset>(n)
    val right = ArrayList<Offset>(n)
    for (i in 0 until n) {
        val a = pts[maxOf(0, i - 1)]
        val b = pts[minOf(n - 1, i + 1)]
        var dx = b.x - a.x
        var dy = b.y - a.y
        val len = Math.hypot(dx.toDouble(), dy.toDouble()).toFloat().let { if (it == 0f) 1f else it }
        dx /= len; dy /= len
        val nx = -dy; val ny = dx
        val w = forceToWidth(pts[i].force) / 2f
        left.add(Offset(tx(pts[i].x + nx * w), ty(pts[i].y + ny * w)))
        right.add(Offset(tx(pts[i].x - nx * w), ty(pts[i].y - ny * w)))
    }
    path.moveTo(left[0].x, left[0].y)
    for (i in 1 until n) path.lineTo(left[i].x, left[i].y)
    for (i in n - 1 downTo 0) path.lineTo(right[i].x, right[i].y)
    path.close()
    return path
}
