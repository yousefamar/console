package io.amar.console.ui.feeds

import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MarkChatRead
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import coil.compose.AsyncImage
import io.amar.console.data.db.FeedItemRow
import io.amar.console.data.db.FeedRow
import io.amar.console.data.feeds.FeedsRepository
import io.amar.console.data.feeds.HnComment
import io.amar.console.data.feeds.extractHnItemId
import io.amar.console.data.feeds.extractYoutubeId
import io.amar.console.data.feeds.feedUnreadCounts
import io.amar.console.data.feeds.hnTimeAgo
import io.amar.console.data.feeds.parseHnTree
import io.amar.console.data.feeds.relativeTime
import io.amar.console.data.feeds.youtubeThumbUrl
import io.amar.console.data.feeds.youtubeWatchUrl
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------- //
// Scope of the current view: All / a folder / a single feed.

private sealed interface FeedScope {
    data object All : FeedScope
    data class FolderScope(val folder: String) : FeedScope
    data class Feed(val feedId: String) : FeedScope
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedsScreen(repo: FeedsRepository, onOpenItem: (String) -> Unit, onGrid: () -> Unit = {}) {
    val items by repo.observeItems().collectAsState(initial = emptyList())
    val feeds by repo.observeFeeds().collectAsState(initial = emptyList())
    val readIds by repo.observeReadIds().collectAsState(initial = emptyList())
    val readSet = remember(readIds) { readIds.toSet() }
    val scope = rememberCoroutineScope()

    val feedById = remember(feeds) { feeds.associateBy { it.id } }
    val feedFolders = remember(feeds) { feeds.associate { it.id to it.folder } }
    val feedUnread = remember(items, readSet) { feedUnreadCounts(items, readSet) }
    // Folder → member feed ids (alpha), plus the top-level (folderless) feeds.
    val folderNames = remember(feeds) { feeds.mapNotNull { it.folder }.distinct().sorted() }
    val folderFeeds = remember(feeds) { feeds.filter { it.folder != null }.groupBy { it.folder!! } }
    val topLevelFeeds = remember(feeds) { feeds.filter { it.folder == null }.sortedBy { it.title.lowercase() } }
    val totalUnread = remember(items, readSet) { items.count { it.id !in readSet } }

    var currentScope by rememberSaveable(stateSaver = feedScopeSaver) { mutableStateOf<FeedScope>(FeedScope.All) }
    var expandedFolders by rememberSaveable(stateSaver = stringSetSaver) { mutableStateOf(emptySet<String>()) }
    var showRead by rememberSaveable { mutableStateOf(false) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<FeedItemRow>>(emptyList()) }
    var confirmMarkAll by remember { mutableStateOf(false) }
    var showAdd by remember { mutableStateOf(false) }
    var feedMenuFor by remember { mutableStateOf<FeedRow?>(null) }
    var feedInfoFor by remember { mutableStateOf<FeedRow?>(null) }
    var refreshing by remember { mutableStateOf(false) }

    LaunchedEffect(searchQuery) {
        searchResults = if (searchQuery.length >= 2) repo.search(searchQuery) else emptyList()
    }
    // Auto-refresh every 15 min while the feed pane is open (SPA useSync parity;
    // the background SyncEngine reconcile still covers foreground/reconnect).
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(15 * 60 * 1000L)
            runCatching { repo.reconcile() }
        }
    }

    fun scopeFeedIds(s: FeedScope): List<String>? = when (s) {
        FeedScope.All -> null
        is FeedScope.FolderScope -> folderFeeds[s.folder]?.map { it.id } ?: emptyList()
        is FeedScope.Feed -> listOf(s.feedId)
    }
    fun folderUnread(folder: String): Int =
        folderFeeds[folder]?.sumOf { feedUnread[it.id] ?: 0 } ?: 0

    // Visible items for the current scope, then unread filter.
    val scopeIds = scopeFeedIds(currentScope)
    val visible = remember(items, currentScope, showRead, readSet, feedFolders, scopeIds) {
        items.filter { item ->
            (scopeIds == null || item.feedId in scopeIds) &&
                (showRead || item.id !in readSet)
        }
    }
    val scopeUnread = when (val s = currentScope) {
        FeedScope.All -> totalUnread
        is FeedScope.FolderScope -> folderUnread(s.folder)
        is FeedScope.Feed -> feedUnread[s.feedId] ?: 0
    }
    val scopeTitle = when (val s = currentScope) {
        FeedScope.All -> "All Feeds"
        is FeedScope.FolderScope -> s.folder
        is FeedScope.Feed -> feedById[s.feedId]?.title ?: "Feed"
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = scopeTitle,
            subtitle = if (scopeUnread > 0) "$scopeUnread unread" else "$totalUnread total unread",
            onGrid = onGrid,
            actions = {
                IconButton(onClick = { showAdd = true }) {
                    Icon(Icons.Filled.Add, "Add feed", modifier = Modifier.size(20.dp))
                }
                IconButton(onClick = { showRead = !showRead }) {
                    Icon(
                        Icons.Filled.DoneAll,
                        contentDescription = if (showRead) "Show unread only" else "Show all (incl. read)",
                        modifier = Modifier.size(20.dp),
                        tint = if (showRead) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = { confirmMarkAll = true }, enabled = scopeUnread > 0) {
                    Icon(Icons.Filled.MarkEmailUnread, "Mark all read", modifier = Modifier.size(20.dp))
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
                placeholder = { Text("Search articles…") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                singleLine = true,
            )
            LazyColumn(Modifier.fillMaxSize()) {
                items(searchResults, key = { it.id }) { item ->
                    FeedItemCard(
                        item,
                        feedName = feedById[item.feedId]?.title,
                        isRead = item.id in readSet,
                        onClick = { searching = false; onOpenItem(item.id) },
                    )
                }
            }
            return
        }

        // Folder / feed selector — a compact tree (expandable folders + rows).
        FeedSelector(
            currentScope = currentScope,
            totalUnread = totalUnread,
            folderNames = folderNames,
            folderFeeds = folderFeeds,
            topLevelFeeds = topLevelFeeds,
            feedUnread = feedUnread,
            expandedFolders = expandedFolders,
            folderUnread = { folderUnread(it) },
            onSelectAll = { currentScope = FeedScope.All },
            onSelectFolder = { currentScope = FeedScope.FolderScope(it) },
            onSelectFeed = { currentScope = FeedScope.Feed(it) },
            onToggleFolder = { f ->
                expandedFolders = if (f in expandedFolders) expandedFolders - f else expandedFolders + f
            },
            onFeedMenu = { feedMenuFor = it },
        )

        // Onboarding: no feeds at all → prompt to add / import.
        if (feeds.isEmpty() && items.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(Icons.Outlined.RssFeed, null, modifier = Modifier.size(48.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("No feeds yet", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                Text(
                    "Add a feed or import an OPML file to get started.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { showAdd = true }, modifier = Modifier.padding(top = 8.dp)) {
                    Text("Import OPML or Add Feed")
                }
            }
            if (showAdd) FeedAddModal(repo = repo, onDismiss = { showAdd = false })
            return
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch { runCatching { repo.reconcile() }; refreshing = false }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            if (visible.isEmpty()) {
                if (showRead) {
                    EmptyState(Icons.Outlined.RssFeed, "No articles", "${items.size} items total")
                } else {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("No unread articles", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${items.size} items cached for offline",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(visible, key = { it.id }) { item ->
                        val dismissState = rememberSwipeToDismissBoxState(
                            positionalThreshold = { total -> total * 0.5f },
                            confirmValueChange = { value ->
                                if (value == SwipeToDismissBoxValue.StartToEnd) {
                                    scope.launch { repo.markRead(item.id) }
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
                                FeedItemCard(
                                    item,
                                    feedName = feedById[item.feedId]?.title,
                                    isRead = item.id in readSet,
                                    onClick = { onOpenItem(item.id) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (confirmMarkAll) {
        AlertDialog(
            onDismissRequest = { confirmMarkAll = false },
            title = { Text("Mark all read?") },
            text = { Text("$scopeUnread unread article(s) in \"$scopeTitle\"") },
            confirmButton = {
                TextButton(onClick = {
                    confirmMarkAll = false
                    scope.launch {
                        when (val s = currentScope) {
                            FeedScope.All -> repo.markAllRead(items.filter { it.id !in readSet }.map { it.id })
                            is FeedScope.FolderScope -> repo.markFolderRead(folderFeeds[s.folder]?.map { it.id } ?: emptyList())
                            is FeedScope.Feed -> repo.markFeedRead(s.feedId)
                        }
                    }
                }) { Text("Mark read") }
            },
            dismissButton = { TextButton(onClick = { confirmMarkAll = false }) { Text("Cancel") } },
        )
    }

    // Per-feed context menu (mark read / info / open site / copy URL / delete).
    feedMenuFor?.let { feed ->
        FeedContextSheet(
            feed = feed,
            onDismiss = { feedMenuFor = null },
            onMarkRead = { scope.launch { repo.markFeedRead(feed.id) }; feedMenuFor = null },
            onInfo = { feedInfoFor = feed; feedMenuFor = null },
            onDelete = {
                feedMenuFor = null
                scope.launch {
                    repo.deleteFeed(feed.id)
                    if (currentScope == FeedScope.Feed(feed.id)) currentScope = FeedScope.All
                }
            },
        )
    }

    feedInfoFor?.let { feed ->
        FeedInfoSheet(feed = feed, repo = repo, onDismiss = { feedInfoFor = null })
    }

    if (showAdd) {
        FeedAddModal(repo = repo, onDismiss = { showAdd = false })
    }
}

// ---------------------------------------------------------------------- //
// Folder / feed selector (compact tree).

@Composable
private fun FeedSelector(
    currentScope: FeedScope,
    totalUnread: Int,
    folderNames: List<String>,
    folderFeeds: Map<String, List<FeedRow>>,
    topLevelFeeds: List<FeedRow>,
    feedUnread: Map<String, Int>,
    expandedFolders: Set<String>,
    folderUnread: (String) -> Int,
    onSelectAll: () -> Unit,
    onSelectFolder: (String) -> Unit,
    onSelectFeed: (String) -> Unit,
    onToggleFolder: (String) -> Unit,
    onFeedMenu: (FeedRow) -> Unit,
) {
    if (folderNames.isEmpty() && topLevelFeeds.isEmpty()) return
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        SelectorRow(
            label = "All",
            unread = totalUnread,
            selected = currentScope == FeedScope.All,
            icon = { Icon(Icons.Outlined.RssFeed, null, modifier = Modifier.size(14.dp)) },
            onClick = onSelectAll,
        )
        for (folder in folderNames) {
            val expanded = folder in expandedFolders
            SelectorRow(
                label = folder,
                unread = folderUnread(folder),
                selected = currentScope == FeedScope.FolderScope(folder),
                indent = 0,
                icon = {
                    Icon(
                        if (expanded) Icons.Filled.ExpandMore else Icons.Filled.ChevronRight,
                        "Toggle folder",
                        modifier = Modifier.size(14.dp).clickable { onToggleFolder(folder) },
                    )
                    Icon(Icons.Filled.Folder, null, modifier = Modifier.size(14.dp))
                },
                onClick = { onSelectFolder(folder) },
            )
            if (expanded) {
                for (feed in folderFeeds[folder].orEmpty().sortedBy { it.title.lowercase() }) {
                    SelectorRow(
                        label = feed.title,
                        unread = feedUnread[feed.id] ?: 0,
                        selected = currentScope == FeedScope.Feed(feed.id),
                        indent = 1,
                        onClick = { onSelectFeed(feed.id) },
                        onLongClick = { onFeedMenu(feed) },
                    )
                }
            }
        }
        for (feed in topLevelFeeds) {
            SelectorRow(
                label = feed.title,
                unread = feedUnread[feed.id] ?: 0,
                selected = currentScope == FeedScope.Feed(feed.id),
                onClick = { onSelectFeed(feed.id) },
                onLongClick = { onFeedMenu(feed) },
            )
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun SelectorRow(
    label: String,
    unread: Int,
    selected: Boolean,
    indent: Int = 0,
    icon: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.background)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(start = (10 + indent * 16).dp, end = 12.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        icon?.invoke()
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (unread > 0) {
            Text(
                unread.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

// ---------------------------------------------------------------------- //
// Feed item row.

@Composable
private fun FeedItemCard(item: FeedItemRow, feedName: String?, isRead: Boolean, onClick: () -> Unit) {
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
            // Relative time · feed · author.
            val meta = buildList {
                add(relativeTime(item.publishedAt, System.currentTimeMillis()))
                feedName?.takeIf { it.isNotBlank() }?.let { add(it) }
                item.author?.takeIf { it.isNotBlank() }?.let { add(it) }
            }.filter { it.isNotBlank() }.joinToString("  ·  ")
            if (meta.isNotBlank()) {
                Text(
                    meta,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            item.snippet?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val thumb = youtubeId?.let { youtubeThumbUrl(it) } ?: item.imageUrl
        if (thumb != null) {
            Box(Modifier.size(64.dp, 40.dp).clip(RoundedCornerShape(6.dp))) {
                AsyncImage(
                    model = thumb,
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
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

// ---------------------------------------------------------------------- //
// Add-feed modal (URL + folder autocomplete + full-text + OPML import).

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedAddModal(repo: FeedsRepository, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var folder by remember { mutableStateOf("") }
    var fullText by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var existingFolders by remember { mutableStateOf<List<String>>(emptyList()) }
    var opmlXml by remember { mutableStateOf<String?>(null) }
    var importing by remember { mutableStateOf(false) }
    val ctx = androidx.compose.ui.platform.LocalContext.current

    LaunchedEffect(Unit) { existingFolders = repo.folderNames() }

    val filteredFolders = remember(folder, existingFolders) {
        if (folder.isBlank()) existingFolders
        else existingFolders.filter { it.contains(folder, ignoreCase = true) }
    }

    // File picker for OPML import.
    val picker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        importing = true
        scope.launch {
            val xml = runCatching {
                ctx.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
            }.getOrNull()
            if (xml != null) repo.importOpml(xml)
            importing = false
            onDismiss()
        }
    }

    fun submit() {
        val u = url.trim()
        if (u.isEmpty()) { onDismiss(); return } // folder-only: nothing to persist
        adding = true
        scope.launch {
            repo.addFeed(u, folder.trim().ifBlank { null }, fullText)
            adding = false
            onDismiss()
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Add feed", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                placeholder = { Text("https://example.com/feed.xml") },
                label = { Text("Feed URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = folder,
                onValueChange = { folder = it },
                placeholder = { Text("Folder (optional)") },
                label = { Text("Folder") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (filteredFolders.isNotEmpty() && folder.isNotBlank()) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (f in filteredFolders.take(4)) {
                        TextButton(onClick = { folder = f }) { Text(f, style = MaterialTheme.typography.labelSmall) }
                    }
                }
            }
            if (url.isNotBlank()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = fullText, onCheckedChange = { fullText = it })
                    Text("Fetch full article text", style = MaterialTheme.typography.bodySmall)
                }
            }
            TextButton(
                onClick = { submit() },
                enabled = !adding && (url.isNotBlank() || folder.isNotBlank()),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Add, null, modifier = Modifier.size(16.dp))
                Text(if (adding) "  Adding…" else "  Add feed")
            }
            TextButton(
                onClick = { picker.launch("*/*") },
                enabled = !importing,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.AutoMirrored.Filled.OpenInNew, null, modifier = Modifier.size(16.dp))
                Text(if (importing) "  Importing…" else "  Import OPML file")
            }
        }
    }
}

// ---------------------------------------------------------------------- //
// Feed context menu (bottom sheet — mobile analogue of the right-click menu).

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedContextSheet(
    feed: FeedRow,
    onDismiss: () -> Unit,
    onMarkRead: () -> Unit,
    onInfo: () -> Unit,
    onDelete: () -> Unit,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val clipboard = LocalClipboardManager.current
    var confirmDelete by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(
                feed.title,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            SheetAction(Icons.Filled.MarkChatRead, "Mark all read", onClick = onMarkRead)
            SheetAction(Icons.Filled.MoreVert, "Feed info", onClick = onInfo)
            feed.siteUrl?.let { site ->
                SheetAction(Icons.AutoMirrored.Filled.OpenInNew, "Open site") {
                    runCatching {
                        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(site)))
                    }
                    onDismiss()
                }
            }
            feed.xmlUrl?.let { xml ->
                SheetAction(Icons.Filled.MoreVert, "Copy feed URL") {
                    clipboard.setText(AnnotatedString(xml)); onDismiss()
                }
            }
            SheetAction(Icons.Filled.Close, "Delete feed", destructive = true) { confirmDelete = true }
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Unsubscribe?") },
            text = { Text("Unsubscribe from ${feed.title}?") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) {
                    Text("Unsubscribe", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SheetAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            icon, null, modifier = Modifier.size(18.dp),
            tint = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FeedInfoSheet(feed: FeedRow, repo: FeedsRepository, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var fullText by remember { mutableStateOf(feed.fullText) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(feed.title, style = MaterialTheme.typography.titleMedium)
            feed.xmlUrl?.let {
                InfoRow("Feed URL", it) { clipboard.setText(AnnotatedString(it)) }
            }
            feed.siteUrl?.let {
                InfoRow("Site URL", it) { clipboard.setText(AnnotatedString(it)) }
            }
            feed.folder?.let { InfoRow("Folder", it, null) }
            feed.addedAt?.let {
                val display = runCatching {
                    SimpleDateFormat("MMM d, yyyy", Locale.US).format(Date(java.time.Instant.parse(it).toEpochMilli()))
                }.getOrDefault(it)
                InfoRow("Added", display, null)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = fullText,
                    onCheckedChange = {
                        fullText = it
                        scope.launch { repo.updateFeed(feed.id, fullText = it) }
                    },
                )
                Text("Fetch full article text", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String, onCopy: (() -> Unit)?) {
    Column(
        Modifier.fillMaxWidth().let { if (onCopy != null) it.clickable(onClick = onCopy) else it },
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            color = if (onCopy != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// ---------------------------------------------------------------------- //
// Article detail.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedItemScreen(repo: FeedsRepository, itemId: String, onBack: () -> Unit) {
    var item by remember { mutableStateOf<FeedItemRow?>(null) }
    var feed by remember { mutableStateOf<FeedRow?>(null) }
    var isRead by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmUnsub by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current

    LaunchedEffect(itemId) {
        val it = repo.itemById(itemId)
        item = it
        feed = it?.feedId?.let { fid -> repo.feedById(fid) }
        // NO mark-read on open (house rule, same as chat/mail): reading state
        // changes only by explicit action — the toggle here or a list swipe.
        isRead = repo.isRead(itemId)
    }

    val hnItemId = remember(item?.content) { extractHnItemId(item?.content) }

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
                    if (isRead) repo.markUnread(itemId) else repo.markRead(itemId)
                    isRead = !isRead
                }
            }) {
                Icon(
                    Icons.Filled.MarkEmailUnread,
                    contentDescription = if (isRead) "Mark unread" else "Mark read",
                    modifier = Modifier.size(18.dp),
                    tint = if (isRead) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item?.link?.let { link ->
                IconButton(onClick = { openUrl(ctx, link) }) {
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, "Open in browser", modifier = Modifier.size(18.dp))
                }
            }
            // Per-feed item-limit menu (⋯).
            feed?.let { f ->
                Box {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Filled.MoreVert, "Feed options", modifier = Modifier.size(18.dp))
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        Text(
                            "Limit ${f.title}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                        for (n in listOf(3, 5, 10, 25, null)) {
                            val active = f.maxItems == n
                            DropdownMenuItem(
                                text = { Text(if (n == null) "Unlimited" else "Top $n") },
                                leadingIcon = {
                                    if (active) Icon(Icons.Filled.CheckCircle, null, modifier = Modifier.size(16.dp))
                                    else Box(Modifier.size(16.dp))
                                },
                                onClick = {
                                    menuOpen = false
                                    scope.launch {
                                        if (n == null) repo.updateFeed(f.id, clearMaxItems = true)
                                        else repo.updateFeed(f.id, maxItems = n)
                                        feed = repo.feedById(f.id)
                                    }
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Unsubscribe", color = MaterialTheme.colorScheme.error) },
                            onClick = { menuOpen = false; confirmUnsub = true },
                        )
                    }
                }
            }
        }

        // Meta line: feed · author · date, + comments link.
        item?.let { it2 ->
            val date = if (it2.publishedAt > 0)
                SimpleDateFormat("MMM d, yyyy", Locale.US).format(Date(it2.publishedAt)) else ""
            val meta = buildList {
                feed?.title?.takeIf { it.isNotBlank() }?.let { add(it) }
                it2.author?.takeIf { it.isNotBlank() }?.let { add(it) }
                if (date.isNotBlank()) add(date)
            }.joinToString("  ·  ")
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    meta,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val commentsUrl = when {
                    hnItemId != null -> "https://news.ycombinator.com/item?id=$hnItemId"
                    it2.link?.contains("reddit.com/r/") == true -> it2.link
                    else -> null
                }
                if (commentsUrl != null) {
                    TextButton(onClick = { openUrl(ctx, commentsUrl) }) {
                        Text(if (hnItemId != null) "HN" else "Comments", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
            val youtubeId = remember(item?.link) { extractYoutubeId(item?.link) }
            if (youtubeId != null) {
                // In-app playback via a JS-enabled WebView loading the nocookie embed
                // (matches the SPA's single-iframe player; falls back to the app on tap-out).
                YouTubeEmbed(youtubeId)
                item?.snippet?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 10.dp))
                }
            } else {
                val html = item?.content
                if (html != null) {
                    val doc = """
                        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
                        <style>body{background:#0a0a0a;color:#e5e5e5;font-family:sans-serif;font-size:15px;line-height:1.5;margin:0;word-break:break-word}
                        a{color:#60a5fa}img{max-width:100%;height:auto}pre{background:#141414;padding:8px;border-radius:4px;overflow-x:auto}
                        blockquote{border-left:2px solid #333;padding-left:12px;font-style:italic;color:#aaa}
                        /* Reddit RSS wraps thumbnail+text in a table — a 70px cell
                           beside a wall of text reads broken on a phone. Stack cells. */
                        table,tbody,tr,td{display:block;width:100%!important;border:0}
                        td{padding:0 0 8px 0}</style></head><body>$html</body></html>
                    """.trimIndent()
                    // All links → external browser (SPA forces target=_blank).
                    io.amar.console.ui.components.SelfSizingWebView(doc, onOpenUrl = { openUrl(ctx, it) })
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) {
                        Text(
                            "No article content available",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        item?.link?.let { link ->
                            TextButton(onClick = { openUrl(ctx, link) }) { Text("Open in browser") }
                        }
                    }
                }
            }

            // HN comments inline under the article.
            if (hnItemId != null) HnCommentsSection(repo, hnItemId)
        }
    }

    if (confirmUnsub) {
        val f = feed
        AlertDialog(
            onDismissRequest = { confirmUnsub = false },
            title = { Text("Unsubscribe?") },
            text = { Text("Unsubscribe from ${f?.title ?: "this feed"}?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnsub = false
                    if (f != null) scope.launch { repo.deleteFeed(f.id); onBack() }
                }) { Text("Unsubscribe", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmUnsub = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun YouTubeEmbed(youtubeId: String) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(8.dp))) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { c ->
                WebView(c).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    setBackgroundColor(android.graphics.Color.BLACK)
                    webViewClient = android.webkit.WebViewClient()
                    // HTML5 <video> needs a WebChromeClient or playback never
                    // starts (black box); and the iframe-wrapper page tripped
                    // YouTube's embed origin check ("Video unavailable") — load
                    // the embed URL directly instead.
                    webChromeClient = android.webkit.WebChromeClient()
                    loadUrl("https://www.youtube-nocookie.com/embed/$youtubeId?playsinline=1&rel=0")
                }
            },
        )
    }
}

@Composable
private fun HnCommentsSection(repo: FeedsRepository, hnItemId: String) {
    var tree by remember { mutableStateOf<HnComment?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(hnItemId) {
        loading = true; error = null
        val raw = repo.hnComments(hnItemId)
        if (raw == null) { error = "network"; loading = false }
        else { tree = parseHnTree(raw); loading = false }
    }

    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        val t = tree
        Text(
            when {
                loading -> "Loading comments…"
                error != null -> "Failed to load comments: $error"
                t != null -> "${t.descendants ?: 0} Comments" + (t.score?.let { "  ·  $it points" } ?: "")
                else -> ""
            },
            style = MaterialTheme.typography.titleSmall,
            color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        t?.children?.forEach { HnCommentThread(it, depth = 0) }
    }
}

@Composable
private fun HnCommentThread(comment: HnComment, depth: Int) {
    if (comment.text == null) return
    var collapsed by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = if (depth > 0) 8.dp else 0.dp, top = 6.dp)
            .then(
                if (depth > 0) Modifier.background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.0f)) else Modifier
            ),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable { collapsed = !collapsed },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                if (collapsed) Icons.Filled.ChevronRight else Icons.Filled.ExpandLess,
                null, modifier = Modifier.size(12.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                comment.by ?: "?",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
            )
            Text("·", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                hnTimeAgo(comment.time, System.currentTimeMillis() / 1000),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (collapsed && comment.children.isNotEmpty()) {
                Text(
                    "(${comment.children.size} ${if (comment.children.size == 1) "reply" else "replies"})",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (!collapsed) {
            Text(
                htmlToPlain(comment.text),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp, start = 18.dp),
            )
            Column(
                Modifier.padding(start = 12.dp).background(MaterialTheme.colorScheme.background),
            ) {
                comment.children.forEach { HnCommentThread(it, depth + 1) }
            }
        }
    }
}

/** Crude HTML → text for HN comment bodies (entities + tags stripped). */
private fun htmlToPlain(html: String): String =
    html.replace(Regex("<p>"), "\n\n")
        .replace(Regex("<[^>]+>"), "")
        .replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&")
        .replace("&#x2F;", "/").replace("&#x27;", "'").replace("&quot;", "\"")
        .trim()

private fun openUrl(ctx: android.content.Context, url: String) {
    runCatching {
        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    }
}

// --- Savers for the compact scope state (survives rotation/process death) --- //

private val feedScopeSaver = androidx.compose.runtime.saveable.Saver<FeedScope, String>(
    save = { s ->
        when (s) {
            FeedScope.All -> "all"
            is FeedScope.FolderScope -> "folder:${s.folder}"
            is FeedScope.Feed -> "feed:${s.feedId}"
        }
    },
    restore = { raw ->
        when {
            raw == "all" -> FeedScope.All
            raw.startsWith("folder:") -> FeedScope.FolderScope(raw.removePrefix("folder:"))
            raw.startsWith("feed:") -> FeedScope.Feed(raw.removePrefix("feed:"))
            else -> FeedScope.All
        }
    },
)

private val stringSetSaver = androidx.compose.runtime.saveable.Saver<Set<String>, String>(
    save = { it.joinToString("\n") },
    restore = { if (it.isEmpty()) emptySet() else it.split("\n").toSet() },
)
