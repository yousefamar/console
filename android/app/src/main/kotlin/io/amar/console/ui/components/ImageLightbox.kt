package io.amar.console.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage

/**
 * Full-screen image lightbox over ready-to-load Coil models (URLs / Files),
 * with ‹ › paging and an "i / total" counter — the SPA `ImageLightbox`
 * gallery for transcript images and kanban card attachments. (Chat keeps its
 * own variant: its images resolve lazily through the E2EE media cache.)
 */
@Composable
fun ImageLightbox(models: List<Any>, startIndex: Int, onClose: () -> Unit) {
    if (models.isEmpty()) { onClose(); return }
    var index by remember { mutableIntStateOf(startIndex.coerceIn(0, models.size - 1)) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.fillMaxSize().background(Color.Black).clickable { onClose() },
            contentAlignment = Alignment.Center,
        ) {
            AsyncImage(model = models[index], contentDescription = null, modifier = Modifier.fillMaxWidth())
            if (models.size > 1) {
                if (index > 0) {
                    IconButton(onClick = { index-- }, modifier = Modifier.align(Alignment.CenterStart).padding(8.dp)) {
                        Icon(Icons.Filled.ChevronLeft, "Previous", tint = Color.White, modifier = Modifier.size(36.dp))
                    }
                }
                if (index < models.size - 1) {
                    IconButton(onClick = { index++ }, modifier = Modifier.align(Alignment.CenterEnd).padding(8.dp)) {
                        Icon(Icons.Filled.ChevronRight, "Next", tint = Color.White, modifier = Modifier.size(36.dp))
                    }
                }
                Text(
                    "${index + 1} / ${models.size}",
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color.Black.copy(alpha = 0.5f))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
    }
}
