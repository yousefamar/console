package io.amar.console.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.amar.console.HubTokenStore
import io.amar.console.core.HubConfig

/**
 * The one video player: a VideoView + MediaController — the `<video controls>`
 * twin. Hub URLs need the bearer, and Coil's interceptor only covers images, so
 * `setVideoURI(uri, headers)` carries it. Used inline by the transcript
 * (`TranscriptBlocks.InlineVideo`) and full-screen by [VideoLightbox] for
 * board-card clips.
 */
@Composable
fun HubVideoView(model: String, modifier: Modifier = Modifier, autoplay: Boolean = false, onError: () -> Unit) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            android.widget.VideoView(ctx).apply {
                val headers = HashMap<String, String>()
                if (model.startsWith(HubConfig.hubBase)) {
                    HubTokenStore.get()?.let { headers["Authorization"] = "Bearer $it" }
                }
                setVideoURI(android.net.Uri.parse(model), headers)
                val controller = android.widget.MediaController(ctx)
                controller.setAnchorView(this)
                setMediaController(controller)
                setOnPreparedListener { mp ->
                    mp.isLooping = false
                    if (autoplay) start() else seekTo(1) // first frame as poster
                }
                setOnErrorListener { _, _, _ -> onError(); true }
            }
        },
    )
}

/**
 * Full-screen clip player over a black scrim — the SPA global lightbox in
 * `video` mode (`CardClipTile` → `setLightboxSrc(url, 'video')`). Nothing is
 * fetched until this mounts; a failed load shows the path instead of a black
 * box. Tap outside the frame to close.
 */
@Composable
fun VideoLightbox(model: String, label: String, onClose: () -> Unit) {
    var failed by remember(model) { mutableStateOf(false) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.fillMaxSize().background(Color.Black).clickable { onClose() },
            contentAlignment = Alignment.Center,
        ) {
            if (failed) {
                Text(
                    "Couldn't play $label",
                    style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.8f),
                    modifier = Modifier.padding(24.dp),
                )
            } else {
                HubVideoView(
                    model = model,
                    autoplay = true,
                    modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f),
                    onError = { failed = true },
                )
            }
        }
    }
}
