package io.amar.console.ui.notes

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.notes.CirclesLayout

/**
 * Circle-pack visualisation of the vault (Machete/Dendron-style). Uses the pure
 * [CirclesLayout] to pack files (area-weighted by size) + synthesized folders,
 * then renders on a Canvas with pan/pinch zoom, tap-to-open a file, tap-a-folder
 * to zoom in, tap-background to pop up a level, and long-press-drag to move a
 * file (drop on a folder → confirm move). Machete level-of-detail: a folder's
 * opaque cover fades once its apparent radius exceeds 0.4×min(W,H).
 * (src/components/notes/CirclesView.tsx + circles-view-helpers.ts)
 */
@Composable
fun CirclesView(
    files: List<NoteFileRow>,
    accent: Color,
    onOpenFile: (String) -> Unit,
    onMove: (from: String, toDir: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val root = remember(files) { CirclesLayout.build(files) }
    // World→screen transform: scale k + translate (tx,ty). Fit root initially.
    var k by remember(root) { mutableStateOf(1.0) }
    var tx by remember(root) { mutableStateOf(0.0) }
    var ty by remember(root) { mutableStateOf(0.0) }
    var viewW by remember { mutableStateOf(1f) }
    var viewH by remember { mutableStateOf(1f) }
    var initialised by remember(root) { mutableStateOf(false) }
    var focusPath by remember(root) { mutableStateOf(CirclesLayout.ROOT_PATH) }
    var moveConfirm by remember { mutableStateOf<Pair<String, CirclesLayout.Node>?>(null) }
    var search by remember { mutableStateOf("") }

    fun worldToScreenX(x: Double) = (x * k + tx)
    fun worldToScreenY(y: Double) = (y * k + ty)
    fun screenToWorldX(sx: Float) = (sx - tx) / k
    fun screenToWorldY(sy: Float) = (sy - ty) / k

    fun fitTo(node: CirclesLayout.Node, pad: Double = 1.05) {
        val kk = (minOf(viewW, viewH) / (2 * node.r)) * pad
        k = kk
        tx = viewW / 2.0 - node.x * kk
        ty = viewH / 2.0 - node.y * kk
        focusPath = node.path
    }

    if (root == null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No notes in vault", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    val fadeThreshold = remember(viewW, viewH) { CirclesLayout.coverFadeThreshold(viewW.toDouble(), viewH.toDouble()) }

    Box(modifier.fillMaxSize()) {
        Canvas(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .pointerInput(root) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        val newK = (k * zoom).coerceIn(0.5 * (minOf(viewW, viewH) / (2 * root.r)), 200.0)
                        k = newK
                        tx += pan.x
                        ty += pan.y
                    }
                }
                .pointerInput(root, k, tx, ty) {
                    detectTapGestures(
                        onLongPress = { pos ->
                            // Long-press a file → begin a move to whatever folder
                            // is under a subsequent tap. Simplified: immediately
                            // prompt to move to the enclosing folder chain.
                            val hit = CirclesLayout.hitTest(root, screenToWorldX(pos.x), screenToWorldY(pos.y), k, fadeThreshold)
                            if (hit != null && hit.isFile) {
                                val folder = CirclesLayout.findDeepestFolderAt(root, screenToWorldX(pos.x), screenToWorldY(pos.y), hit.path)
                                if (folder != null && folder.path != CirclesLayout.parentPathOf(hit.path)) {
                                    moveConfirm = hit.path to folder
                                }
                            }
                        },
                        onTap = { pos ->
                            val hit = CirclesLayout.hitTest(root, screenToWorldX(pos.x), screenToWorldY(pos.y), k, fadeThreshold)
                            when {
                                hit == null -> {
                                    // Background → pop up one level.
                                    val cur = CirclesLayout.findNode(root, focusPath)
                                    val parent = cur?.parent
                                    if (parent != null) fitTo(parent)
                                }
                                hit.isFile -> onOpenFile(hit.path)
                                else -> fitTo(hit)
                            }
                        },
                    )
                },
        ) {
            viewW = size.width
            viewH = size.height
            if (!initialised) {
                val kk = (minOf(size.width, size.height) / (2 * root.r)) * 1.0
                k = kk; tx = size.width / 2.0 - root.x * kk; ty = size.height / 2.0 - root.y * kk
                initialised = true
            }
            drawCircles(root, k, tx, ty, fadeThreshold, accent, search)
        }

        // Breadcrumb + up button.
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            IconButton(
                onClick = { fitTo(root) },
                enabled = focusPath != CirclesLayout.ROOT_PATH,
            ) { Icon(Icons.Filled.ArrowUpward, "Zoom to root") }
            Text(
                if (focusPath == CirclesLayout.ROOT_PATH) "vault" else "vault / $focusPath",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }

    moveConfirm?.let { (from, folder) ->
        AlertDialog(
            onDismissRequest = { moveConfirm = null },
            title = { Text("Move file?") },
            text = { Text("Move \"${from.substringAfterLast('/')}\" to ${folder.path}?") },
            confirmButton = {
                TextButton(onClick = { onMove(from, folder.path); moveConfirm = null }) { Text("Move") }
            },
            dismissButton = { TextButton(onClick = { moveConfirm = null }) { Text("Cancel") } },
        )
    }
}

private fun DrawScope.drawCircles(
    root: CirclesLayout.Node,
    k: Double,
    tx: Double,
    ty: Double,
    fadeThreshold: Double,
    accent: Color,
    search: String,
) {
    // Painter's algorithm: draw shallow → deep, folders as translucent covers
    // that fade past the threshold to reveal children.
    val nodes = ArrayList<CirclesLayout.Node>()
    CirclesLayout.forEach(root) { if (it.parent != null) nodes.add(it) }
    nodes.sortBy { it.depth }
    for (n in nodes) {
        val apparentR = (n.r * k).toFloat()
        if (apparentR < 0.6f) continue
        if (!CirclesLayout.isAncestorChainOpen(n, k, fadeThreshold)) continue
        val cx = (n.x * k + tx).toFloat()
        val cy = (n.y * k + ty).toFloat()
        val matches = search.isNotBlank() && n.path.contains(search, ignoreCase = true)
        val dim = search.isNotBlank() && !matches
        if (n.isFile) {
            val fill = if (dim) Color(0x33888888) else Color(0x55AAAAAA)
            drawCircle(fill, apparentR, Offset(cx, cy))
            if (matches) drawCircle(accent, apparentR, Offset(cx, cy), style = Stroke(2.4f))
        } else {
            // Folder cover — opaque until apparent radius exceeds threshold.
            val faded = apparentR > fadeThreshold
            if (!faded) {
                val alpha = if (dim) 0.15f else 0.5f
                drawCircle(Color(0xFF2A2A2A).copy(alpha = alpha), apparentR, Offset(cx, cy))
                drawCircle(Color(0x33FFFFFF), apparentR, Offset(cx, cy), style = Stroke(1f))
            }
        }
        // Labels for sufficiently-large circles.
        if (apparentR >= 22f && (n.isFile || (n.r * k) <= fadeThreshold)) {
            drawLabel(n.name, cx, cy, apparentR, dim)
        }
    }
}

private fun DrawScope.drawLabel(name: String, cx: Float, cy: Float, r: Float, dim: Boolean) {
    val paint = android.graphics.Paint().apply {
        color = if (dim) android.graphics.Color.argb(60, 220, 220, 220) else android.graphics.Color.argb(230, 230, 230, 230)
        textSize = 13f * density
        textAlign = android.graphics.Paint.Align.CENTER
        isAntiAlias = true
    }
    val maxW = r * 1.7f
    val label = CirclesLayout.truncateLabel(name, maxW.toDouble()) { paint.measureText(it).toDouble() } ?: return
    drawContext.canvas.nativeCanvas.drawText(label, cx, cy + paint.textSize / 3f, paint)
}
