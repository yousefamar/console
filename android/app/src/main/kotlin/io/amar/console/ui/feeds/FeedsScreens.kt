package io.amar.console.ui.feeds

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.feeds.FeedsRepository
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun FeedsScreen(repo: FeedsRepository, onOpenItem: (String) -> Unit) {
    val items by repo.observeItems().collectAsState(initial = emptyList())
    val readIds by repo.observeReadIds().collectAsState(initial = emptyList())
    val readSet = remember(readIds) { readIds.toSet() }
    val unread = remember(items, readSet) { items.filter { it.id !in readSet } }

    if (unread.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("All read 🎉", style = MaterialTheme.typography.titleMedium)
                Text(
                    "${items.size} items cached for offline",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(unread, key = { it.id }) { item ->
            FeedItemCard(item, onClick = { onOpenItem(item.id) })
        }
    }
}

@Composable
private fun FeedItemCard(item: FeedItemRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                item.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                formatDate(item.publishedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (item.imageUrl != null) {
            AsyncImage(
                model = item.imageUrl,
                contentDescription = null,
                modifier = Modifier.size(56.dp).clip(RoundedCornerShape(6.dp)),
            )
        }
    }
}

@Composable
fun FeedItemScreen(repo: FeedsRepository, itemId: String, onBack: () -> Unit) {
    var item by remember { androidx.compose.runtime.mutableStateOf<FeedItemRow?>(null) }

    LaunchedEffect(itemId) {
        item = repo.itemById(itemId)
        // Opening = read (queued for hub sync).
        repo.markRead(itemId)
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text(
                item?.title ?: "",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            item?.link?.let { link ->
                val ctx = androidx.compose.ui.platform.LocalContext.current
                IconButton(onClick = {
                    runCatching {
                        ctx.startActivity(
                            android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(link))
                        )
                    }
                }) { Icon(Icons.AutoMirrored.Filled.OpenInNew, "Open in browser", modifier = Modifier.size(18.dp)) }
            }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
            val html = item?.content
            if (html != null) {
                // Reuse the strict mail-body renderer pattern via AndroidView.
                androidx.compose.ui.viewinterop.AndroidView(
                    modifier = Modifier.fillMaxWidth(),
                    factory = { ctx ->
                        android.webkit.WebView(ctx).apply {
                            settings.javaScriptEnabled = false
                            setBackgroundColor(android.graphics.Color.TRANSPARENT)
                        }
                    },
                    update = { wv ->
                        val doc = """
                            <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
                            <style>body{background:#0a0a0a;color:#e5e5e5;font-family:sans-serif;font-size:15px;line-height:1.5;margin:0;word-break:break-word}
                            a{color:#60a5fa}img{max-width:100%;height:auto}</style></head><body>$html</body></html>
                        """.trimIndent()
                        wv.loadDataWithBaseURL(null, doc, "text/html", "utf-8", null)
                    },
                )
            } else {
                Text(
                    item?.snippet ?: "No cached content — open in browser",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

private fun formatDate(ts: Long): String {
    if (ts <= 0) return ""
    return SimpleDateFormat("d MMM HH:mm", Locale.UK).format(Date(ts))
}
