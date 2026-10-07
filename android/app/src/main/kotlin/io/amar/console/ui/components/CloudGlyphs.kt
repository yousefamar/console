package io.amar.console.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.FORGE_TOOLTIP

/**
 * SPA `BotCloud` / `BranchCloud` (src/components/icons/): a bot riding a
 * cloud, or a fork's branch growing out of one — marks a session whose claude
 * process runs on forge (AWS). Composites of material icons in a Box (the
 * `CrownedBot` precedent): the cloud fills the bottom, the lineage glyph is
 * shrunk into the top. Remoteness and lineage are separate axes, so a remote
 * fork keeps its branch and only gains the cloud.
 */
@Composable
fun BotCloud(tint: Color, size: Dp = 16.dp) {
    Box(Modifier.size(size)) {
        Icon(Icons.Filled.SmartToy, contentDescription = FORGE_TOOLTIP, tint = tint, modifier = Modifier.size(size * 0.62f).align(Alignment.TopCenter))
        Icon(Icons.Filled.Cloud, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.7f).align(Alignment.BottomCenter))
    }
}

@Composable
fun BranchCloud(tint: Color, cloudTint: Color = tint, size: Dp = 16.dp) {
    Box(Modifier.size(size)) {
        Icon(Icons.AutoMirrored.Filled.CallSplit, contentDescription = FORGE_TOOLTIP, tint = tint, modifier = Modifier.size(size * 0.66f).align(Alignment.TopCenter))
        Icon(Icons.Filled.Cloud, contentDescription = null, tint = cloudTint, modifier = Modifier.size(size * 0.7f).align(Alignment.BottomCenter))
    }
}
