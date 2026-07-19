package io.amar.console.ui.feeds

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
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
import io.amar.console.data.feeds.extractYoutubeId
import io.amar.console.data.feeds.folderNames
import io.amar.console.data.feeds.folderUnreadCounts
import io.amar.console.data.feeds.youtubeThumbUrl
import io.amar.console.data.feeds.youtubeWatchUrl
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedsScreen(repo: FeedsRepository, onOpenItem: (String) -> Unit, onGrid: () -> Unit = {}) {
    val items by repo.observeItems().collectAsState(initial = emptyList())
    val feeds by repo.observeFeeds().collectAsState(initial = emptyList())
    val readIds by repo.observeReadIds().collectAsState(initial = emptyList())
    val readSet = remember(readIds) { readIds.toSet() }
    val scope = rememberCoroutineScope()

    val feedFolders = remember(feeds) { feeds.associate { it.id to it.folder } }
    val folders = remember(feeds) { folderNames(feedFolders) }
    val unreadCounts = remember(items, feedFolders, readSet) {
        folderUnreadCounts(items, feedFolders, readSet)
    }

    var selectedFolder by rememberSaveable { mutableStateOf<String?>(null) }
    var showRead by rememberSaveable { mutableStateOf(false) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<FeedItemRow>>(emptyList()) }
    var confirmMarkAll by remember { mutableStateOf(false) }

    LaunchedEffect(searchQuery) {
        searchResults = if (searchQuery.length >= 2) repo.search(searchQuery) else emptyList()
    }

    // Visible scope: folder filter, then unread filter (unless showing all).
    val visible = remember(items, selectedFolder, showRead, readSet, feedFolders) {
        items.filter { item ->
            (selectedFolder == null || feedFolders[item.feedId] == selectedFolder) &&
                (showRead || item.id !in readSet)
        }
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Feeds",
            subtitle = unreadCounts[null]?.let { "$it unread" },
            actions = {
                IconButton(onClick = { showRead = !showRead }) {
                    Icon(
                        Icons.Filled.DoneAll,
                        contentDescription = if (showRead) "Show unread only" else "Show all (incl. read)",
                        modifier = Modifier.size(20.dp),
                        tint = if (showRead) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = { confirmMarkAll = true }, enabled = visible.any { it.id !in readSet }) {
                    Icon(
                        Icons.Filled.MarkEmailUnread,
                        contentDescription = "Mark all read",
                        modifier = Modifier.size(20.dp),
                    )
                }
                IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                    Icon(
                        if (searching) Icons.Filled.Close else Icons.Filled.Search,
                        contentDescription = "Search feeds",
                        modifier = Modifier.size(20.dp),
                    )
                }
            },
        )

        if (searching) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("Search cached items") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                singleLine = true,
            )
            LazyColumn(Modifier.fillMaxSize()) {
                items(searchResults, key = { it.id }) { item ->
                    FeedItemCard(
                        item,
                        isRead = item.id in readSet,
                        onClick = { searching = false; onOpenItem(item.id) },
                    )
                }
            }
            return
        }

        if (folders.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FolderChip(
                    label = "All",
                    count = unreadCounts[null] ?: 0,
                    selected = selectedFolder == null,
                    onClick = { selectedFolder = null },
                )
                for (folder in folders) {
                    FolderChip(
                        label = folder,
                        count = unreadCounts[folder] ?: 0,
                        selected = selectedFolder == folder,
                        onClick = { selectedFolder = if (selectedFolder == folder) null else folder },
                    )
                }
            }
        }

        if (visible.isEmpty()) {
            if (showRead) {
                EmptyState(Icons.Outlined.RssFeed, "Nothing cached", "${items.size} items total")
            } else {
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
            }
            return
        }

        LazyColumn(Modifier.fillMaxSize()) {
            items(visible, key = { it.id }) { item ->
                val dismissState = rememberSwipeToDismissBoxState(
                    positionalThreshold = { totalDistance -> totalDistance * 0.5f },
                    confirmValueChange = { value ->
                        if (value == SwipeToDismissBoxValue.StartToEnd) {
                            scope.launch { repo.markRead(item.id) }
                            // Row stays (it just gains the read style / leaves the
                            // unread filter via the flow) — don't dismiss-animate.
                            false
                        } else false
                    },
                )
                SwipeToDismissBox(
                    state = dismissState,
                    enableDismissFromEndToStart = false,
                    backgroundContent = {
                        Row(
                            Modifier
                                .fillMaxSize()
                                .background(MaterialTheme.colorScheme.primaryContainer)
                                .padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.DoneAll, contentDescription = null)
                            Text("  Read", style = MaterialTheme.typography.labelMedium)
                        }
                    },
                ) {
                    Box(Modifier.background(MaterialTheme.colorScheme.background)) {
                        FeedItemCard(item, isRead = item.id in readSet, onClick = { onOpenItem(item.id) })
                    }
                }
            }
        }
    }

    if (confirmMarkAll) {
        val unreadVisible = visible.filter { it.id !in readSet }
        AlertDialog(
            onDismissRequest = { confirmMarkAll = false },
            title = { Text("Mark all read?") },
            text = {
                Text(
                    "${unreadVisible.size} item(s)" +
                        (selectedFolder?.let { " in \"$it\"" } ?: ""),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmMarkAll = false
                    scope.launch { repo.markAllRead(unreadVisible.map { it.id }) }
                }) { Text("Mark read") }
            },
            dismissButton = {
                TextButton(onClick = { confirmMarkAll = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun FolderChip(label: String, count: Int, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(if (count > 0) "$label ($count)" else label) },
    )
}

@Composable
private fun FeedItemCard(item: FeedItemRow, isRead: Boolean, onClick: () -> Unit) {
    val youtubeId = remember(item.link) { extractYoutubeId(item.link) }
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
                fontWeight = if (isRead) FontWeight.Normal else FontWeight.Medium,
                color = if (isRead) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                formatDate(item.publishedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val thumb = youtubeId?.let { youtubeThumbUrl(it) } ?: item.imageUrl
        if (thumb != null) {
            Box {
                AsyncImage(
                    model = thumb,
                    contentDescription = null,
                    modifier = Modifier.size(56.dp).clip(RoundedCornerShape(6.dp)),
                )
                if (youtubeId != null) {
                    Icon(
                        Icons.Filled.PlayArrow,
                        contentDescription = null,
                        tint = androidx.compose.ui.graphics.Color.White,
                        modifier = Modifier.align(Alignment.Center).size(22.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun FeedItemScreen(repo: FeedsRepository, itemId: String, onBack: () -> Unit) {
    var item by remember { mutableStateOf<FeedItemRow?>(null) }
    var markedUnread by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current

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
            IconButton(onClick = {
                scope.launch {
                    if (markedUnread) repo.markRead(itemId) else repo.markUnread(itemId)
                    markedUnread = !markedUnread
                }
            }) {
                Icon(
                    Icons.Filled.MarkEmailUnread,
                    contentDescription = if (markedUnread) "Mark read" else "Mark unread",
                    modifier = Modifier.size(18.dp),
                    tint = if (markedUnread) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item?.link?.let { link ->
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
            val youtubeId = remember(item?.link) { extractYoutubeId(item?.link) }
            if (youtubeId != null) {
                // YouTube: big tappable thumbnail → external player (no WebView embed).
                Box(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 9f)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable {
                            runCatching {
                                ctx.startActivity(
                                    android.content.Intent(
                                        android.content.Intent.ACTION_VIEW,
                                        android.net.Uri.parse(item?.link ?: youtubeWatchUrl(youtubeId)),
                                    )
                                )
                            }
                        },
                ) {
                    AsyncImage(
                        model = youtubeThumbUrl(youtubeId),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    )
                    Icon(
                        Icons.Filled.PlayArrow,
                        contentDescription = "Play on YouTube",
                        tint = androidx.compose.ui.graphics.Color.White,
                        modifier = Modifier.align(Alignment.Center).size(64.dp),
                    )
                }
                item?.snippet?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(top = 10.dp),
                    )
                }
                return
            }
            val html = item?.content
            if (html != null) {
                // Reuse the strict mail-body renderer pattern via AndroidView.
                androidx.compose.ui.viewinterop.AndroidView(
                    modifier = Modifier.fillMaxWidth(),
                    factory = { c ->
                        android.webkit.WebView(c).apply {
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
