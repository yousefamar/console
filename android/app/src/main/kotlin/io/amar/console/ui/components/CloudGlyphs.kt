package io.amar.console.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.FORGE_TOOLTIP

/**
 * SPA `BotCloud` / `BranchCloud` (src/components/icons/) ported path-for-path:
 * a bot sitting in a cloud, or a fork's branch sprouting from the same cloud —
 * marks a session whose claude process runs on forge (AWS).
 *
 * These are ONE silhouette, not a stack: the head's sides and the branch's
 * trunk stop where the cloud's top contour passes in front of them, so nothing
 * crosses and the mark still reads at 10px. Both glyphs share the identical
 * cloud path — the cloud base means "remote", the branch means "fork", so a
 * remote fork keeps its branch and only gains the cloud.
 *
 * Geometry is lucide's own (24x24 viewport, 2px round stroke, no fill); the
 * stroke colour is baked per composition, hence `remember` + an unspecified
 * `Icon` tint (a tint there would ColorFilter the whole vector and defeat
 * `cloudTint`).
 */
private fun ImageVector.Builder.lucidePath(color: Color, block: PathBuilder.() -> Unit) =
    path(
        fill = null,
        stroke = SolidColor(color),
        strokeLineWidth = 2f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = block,
    )

private fun lucideBuilder(name: String) = ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
)

/** M5.5 21h13a3.5 3.5 0 0 0 .5-7A14 14 0 0 0 5 14a3.5 3.5 0 0 0 .5 7Z */
private fun ImageVector.Builder.cloudPath(color: Color) = lucidePath(color) {
    moveTo(5.5f, 21f)
    horizontalLineToRelative(13f)
    arcToRelative(3.5f, 3.5f, 0f, isMoreThanHalf = false, isPositiveArc = false, 0.5f, -7f)
    arcTo(14f, 14f, 0f, isMoreThanHalf = false, isPositiveArc = false, 5f, 14f)
    arcToRelative(3.5f, 3.5f, 0f, isMoreThanHalf = false, isPositiveArc = false, 0.5f, 7f)
    close()
}

private fun botCloudVector(tint: Color): ImageVector = lucideBuilder("BotCloud").apply {
    // head: M7 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v7
    lucidePath(tint) {
        moveTo(7f, 12f)
        verticalLineTo(5f)
        arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, 2f, -2f)
        horizontalLineToRelative(6f)
        arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, 2f, 2f)
        verticalLineToRelative(7f)
    }
    // ears: M4 8h2 / M18 8h2
    lucidePath(tint) {
        moveTo(4f, 8f)
        horizontalLineToRelative(2f)
    }
    lucidePath(tint) {
        moveTo(18f, 8f)
        horizontalLineToRelative(2f)
    }
    // eyes: M10 7v2 / M14 7v2
    lucidePath(tint) {
        moveTo(10f, 7f)
        verticalLineToRelative(2f)
    }
    lucidePath(tint) {
        moveTo(14f, 7f)
        verticalLineToRelative(2f)
    }
    cloudPath(tint)
}.build()

private fun branchCloudVector(tint: Color, cloudTint: Color): ImageVector =
    lucideBuilder("BranchCloud").apply {
        // trunk: M8 13.4V3
        lucidePath(tint) {
            moveTo(8f, 13.4f)
            verticalLineTo(3f)
        }
        // node: <circle cx="17" cy="5.5" r="2.5"/>
        lucidePath(tint) {
            moveTo(14.5f, 5.5f)
            arcToRelative(2.5f, 2.5f, 0f, isMoreThanHalf = true, isPositiveArc = true, 5f, 0f)
            arcToRelative(2.5f, 2.5f, 0f, isMoreThanHalf = true, isPositiveArc = true, -5f, 0f)
            close()
        }
        // branch: M17 8a6 6 0 0 1-4.6 4.6
        lucidePath(tint) {
            moveTo(17f, 8f)
            arcToRelative(6f, 6f, 0f, isMoreThanHalf = false, isPositiveArc = true, -4.6f, 4.6f)
        }
        cloudPath(cloudTint)
    }.build()

@Composable
fun BotCloud(tint: Color, size: Dp = 16.dp) {
    val vector = remember(tint) { botCloudVector(tint) }
    Icon(
        imageVector = vector,
        contentDescription = FORGE_TOOLTIP,
        tint = Color.Unspecified,
        modifier = Modifier.size(size),
    )
}

@Composable
fun BranchCloud(tint: Color, cloudTint: Color = tint, size: Dp = 16.dp) {
    val vector = remember(tint, cloudTint) { branchCloudVector(tint, cloudTint) }
    Icon(
        imageVector = vector,
        contentDescription = FORGE_TOOLTIP,
        tint = Color.Unspecified,
        modifier = Modifier.size(size),
    )
}
