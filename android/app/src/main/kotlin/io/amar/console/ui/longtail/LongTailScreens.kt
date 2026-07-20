package io.amar.console.ui.longtail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Style
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.data.db.BookmarkRow
import io.amar.console.data.longtail.BookmarkTagNode
import io.amar.console.data.longtail.BookmarksRepository
import io.amar.console.data.longtail.MusicRepository
import io.amar.console.data.longtail.allBookmarkTags
import io.amar.console.data.longtail.bookmarkDomain
import io.amar.console.data.longtail.buildTagTree
import io.amar.console.data.longtail.filterBookmarks
import io.amar.console.data.longtail.formatAddedDate
import io.amar.console.data.longtail.normalizeUrl
import io.amar.console.data.longtail.parseTagsJson
import io.amar.console.data.longtail.repeatAllowed
import io.amar.console.data.longtail.seekAllowed
import io.amar.console.data.longtail.shuffleAllowed
import io.amar.console.data.longtail.tagSuggestions
import io.amar.console.ui.agents.MarkdownLite
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch

// ---------------------------------------------------------------------- //
// Bookmarks — browse (tag tree + search) · add · triage · detail sheet
// ---------------------------------------------------------------------- //

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookmarksScreen(repo: BookmarksRepository, onGrid: () -> Unit = {}) {
    val bookmarks by repo.observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()

    var selectedTag by rememberSaveable { mutableStateOf<String?>(null) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var expandedTags by rememberSaveable(stateSaver = stringSetSaver) { mutableStateOf(emptySet<String>()) }
    var detail by remember { mutableStateOf<BookmarkRow?>(null) }
    var addMode by remember { mutableStateOf(false) }
    var triageMode by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }

    val tagsByFile = remember(bookmarks) { bookmarks.associate { it.file to parseTagsJson(it.tagsJson) } }
    val allTags = remember(tagsByFile) { allBookmarkTags(tagsByFile) }
    val tagTree = remember(tagsByFile) { buildTagTree(tagsByFile) }

    val visible = remember(bookmarks, selectedTag, searchQuery, tagsByFile) {
        filterBookmarks(bookmarks, tagsByFile, searchQuery, selectedTag)
    }
    val brokenCount = remember(visible, tagsByFile) {
        visible.count { bm -> (tagsByFile[bm.file] ?: emptyList()).any { it == "status/broken" } }
    }

    fun selectTag(tag: String?) {
        if (tag == selectedTag) { selectedTag = null; return }
        selectedTag = tag
        if (tag != null) {
            // Auto-expand ancestors.
            val parts = tag.split('/')
            val add = (parts.indices).map { parts.subList(0, it + 1).joinToString("/") }
            expandedTags = expandedTags + add
        }
    }

    if (addMode) {
        BookmarkAddScreen(repo = repo, allTags = allTags, onExit = { addMode = false })
        return
    }
    if (triageMode) {
        BookmarkTriageScreen(
            repo = repo,
            bookmarks = bookmarks,
            tagsByFile = tagsByFile,
            searchQuery = searchQuery,
            selectedTag = selectedTag,
            allTags = allTags,
            onExit = { triageMode = false },
        )
        return
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Bookmarks",
            subtitle = buildString {
                if (visible.size == bookmarks.size) append("${bookmarks.size} cached")
                else append("${visible.size} of ${bookmarks.size}")
                if (brokenCount > 0) append(" · $brokenCount broken")
            },
            onGrid = onGrid,
            actions = {
                IconButton(onClick = { addMode = true }) {
                    Icon(Icons.Filled.Add, "Add bookmark", modifier = Modifier.size(20.dp))
                }
                IconButton(onClick = { triageMode = true }, enabled = visible.isNotEmpty()) {
                    Icon(Icons.Filled.Style, "Triage", modifier = Modifier.size(20.dp))
                }
                IconButton(onClick = { searching = !searching; searchQuery = "" }) {
                    Icon(
                        if (searching) Icons.Filled.Close else Icons.Filled.Search,
                        contentDescription = "Search bookmarks",
                        modifier = Modifier.size(20.dp),
                    )
                }
            },
        )
        if (searching) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("Title / URL / description / tags") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                singleLine = true,
            )
        }
        // Active-tag clear chip.
        selectedTag?.let { tag ->
            Row(Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) {
                FilterChip(
                    selected = true,
                    onClick = { selectTag(tag) },
                    label = { Text("× $tag") },
                    leadingIcon = { Icon(Icons.Filled.Close, null, modifier = Modifier.size(14.dp)) },
                )
            }
        }
        // Tag tree (hierarchical, expand/collapse, per-tag counts).
        if (tagTree.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
            ) {
                TagTreeRow(
                    label = "All bookmarks",
                    count = bookmarks.size,
                    selected = selectedTag == null,
                    depth = 0,
                    hasChildren = false,
                    expanded = false,
                    onToggle = {},
                    onSelect = { selectTag(null) },
                )
                TagTreeNodes(
                    nodes = tagTree,
                    depth = 0,
                    selectedTag = selectedTag,
                    expandedTags = expandedTags,
                    onSelect = { selectTag(it) },
                    onToggle = { t -> expandedTags = if (t in expandedTags) expandedTags - t else expandedTags + t },
                )
            }
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
                EmptyState(Icons.Outlined.Bookmarks, "No bookmarks found", "connect once to cache the vault listing")
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(visible, key = { it.file }) { bm ->
                        BookmarkListItem(bm, tagsByFile[bm.file] ?: emptyList()) { detail = bm }
                    }
                }
            }
        }
    }

    detail?.let { bm ->
        BookmarkDetailSheet(
            repo = repo,
            bookmark = bm,
            tags = tagsByFile[bm.file] ?: emptyList(),
            allTags = allTags,
            onDismiss = { detail = null },
            onDelete = {
                detail = null
                scope.launch { repo.delete(bm.file) }
            },
        )
    }
}

@Composable
private fun BookmarkListItem(bm: BookmarkRow, tags: List<String>, onClick: () -> Unit) {
    val broken = "status/broken" in tags
    // Hide status/active + status/broken from the visible chips; cap 4 + overflow.
    val chips = tags.filter { it != "status/active" }
    val shown = chips.take(4)
    val overflow = chips.size - shown.size
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .then(
                if (broken) Modifier.border(
                    width = 2.dp,
                    color = MaterialTheme.colorScheme.error,
                    shape = RoundedCornerShape(topStart = 0.dp, bottomStart = 0.dp),
                ) else Modifier
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                bm.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            bm.url?.let {
                Text(
                    bookmarkDomain(it),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            bm.description?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (shown.isNotEmpty() || overflow > 0) {
                Text(
                    buildString {
                        // tags show only the last path segment (tag.split('/').pop())
                        append(shown.joinToString("  ") { "#${it.substringAfterLast('/')}" })
                        if (overflow > 0) append("  +$overflow")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (broken) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// --- Tag tree --- //

@Composable
private fun TagTreeNodes(
    nodes: List<BookmarkTagNode>,
    depth: Int,
    selectedTag: String?,
    expandedTags: Set<String>,
    onSelect: (String) -> Unit,
    onToggle: (String) -> Unit,
) {
    for (node in nodes) {
        val expanded = node.fullPath in expandedTags
        TagTreeRow(
            label = node.name,
            count = node.count,
            selected = selectedTag == node.fullPath,
            depth = depth,
            hasChildren = node.children.isNotEmpty(),
            expanded = expanded,
            onToggle = { onToggle(node.fullPath) },
            onSelect = { onSelect(node.fullPath) },
        )
        if (expanded && node.children.isNotEmpty()) {
            TagTreeNodes(node.children, depth + 1, selectedTag, expandedTags, onSelect, onToggle)
        }
    }
}

@Composable
private fun TagTreeRow(
    label: String,
    count: Int,
    selected: Boolean,
    depth: Int,
    hasChildren: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    onSelect: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.background)
            .clickable(onClick = onSelect)
            .padding(start = (8 + depth * 10).dp, end = 12.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (hasChildren) {
            Text(
                if (expanded) "▾" else "▸",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clickable(onClick = onToggle).padding(horizontal = 2.dp),
            )
        } else {
            Box(Modifier.size(12.dp))
        }
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            count.toString(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// --- Detail sheet (with tag editor) --- //

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BookmarkDetailSheet(
    repo: BookmarksRepository,
    bookmark: BookmarkRow,
    tags: List<String>,
    allTags: List<String>,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<BookmarksRepository.Detail?>(null) }
    var bodyLoading by remember { mutableStateOf(true) }
    var confirmDelete by remember { mutableStateOf(false) }
    // Local editable tag set (server-confirmed writes flow back through reconcile/updateTags).
    var editTags by remember(bookmark.file) { mutableStateOf(tags) }

    LaunchedEffect(bookmark.file) {
        detail = repo.fetchDetail(bookmark.file)
        bodyLoading = false
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 600.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(bookmark.title, style = MaterialTheme.typography.titleMedium)
                    bookmark.url?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.clickable { openBookmark(ctx, it) },
                        )
                    }
                }
                IconButton(onClick = { bookmark.url?.let { openBookmark(ctx, it) } }, enabled = bookmark.url != null) {
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, "Open in browser", modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = { confirmDelete = true }) {
                    Icon(Icons.Filled.Delete, "Delete", modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                }
            }
            (detail?.description ?: bookmark.description)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
            bookmark.archive?.let { archive ->
                Row(
                    Modifier.clickable { openBookmark(ctx, archive) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(Icons.Filled.Archive, null, modifier = Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("Archive snapshot", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            formatAddedDate(bookmark.addedRaw)?.let {
                Text("Added $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            TagEditor(
                tags = editTags,
                allTags = allTags,
                onAdd = { tag ->
                    if (tag.isNotBlank() && tag !in editTags) {
                        editTags = editTags + tag
                        scope.launch { repo.updateTags(bookmark.file, editTags) }
                    }
                },
                onRemove = { tag ->
                    editTags = editTags - tag
                    scope.launch { repo.updateTags(bookmark.file, editTags) }
                },
            )

            when {
                bodyLoading -> Text("Loading…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                detail?.body != null -> {
                    Column {
                        Text("Notes", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        MarkdownLite(detail!!.body!!)
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete bookmark?") },
            text = { Text(bookmark.title) },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagEditor(
    tags: List<String>,
    allTags: List<String>,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    var input by remember { mutableStateOf("") }
    val suggestions = remember(input, allTags, tags) { tagSuggestions(allTags, input, tags.toSet(), 8) }
    Column {
        Text("Tags", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (tag in tags) {
                val destructive = tag == "status/broken"
                Row(
                    Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(
                            if (destructive) MaterialTheme.colorScheme.errorContainer
                            else MaterialTheme.colorScheme.surfaceVariant
                        )
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        tag,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    )
                    Icon(
                        Icons.Filled.Close, "Remove",
                        modifier = Modifier.size(12.dp).clickable { onRemove(tag) },
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        OutlinedTextField(
            value = input,
            onValueChange = { input = it },
            placeholder = { Text("Add tag…") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = {
                val pick = suggestions.firstOrNull() ?: input.trim()
                if (pick.isNotBlank()) { onAdd(pick); input = "" }
            }),
            modifier = Modifier.fillMaxWidth(),
        )
        if (input.isNotBlank() && suggestions.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (s in suggestions) {
                    TextButton(onClick = { onAdd(s); input = "" }) {
                        Text(s, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

// --- Add mode --- //

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun BookmarkAddScreen(repo: BookmarksRepository, allTags: List<String>, onExit: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<BookmarksRepository.Created?>(null) }
    var suggested by remember { mutableStateOf<List<String>>(emptyList()) }
    var selected by remember { mutableStateOf<List<String>>(emptyList()) }
    var customInput by remember { mutableStateOf("") }
    var suggesting by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    fun fetch() {
        val u = url.trim()
        if (u.isEmpty()) return
        loading = true; preview = null; suggested = emptyList(); selected = emptyList()
        scope.launch {
            val created = repo.createBookmark(normalizeUrl(u))
            loading = false
            if (created != null) {
                preview = created
                selected = created.tags
                // Suggest tags in parallel (non-blocking).
                suggesting = true
                val tags = repo.suggestTags(created.title, created.description ?: "", created.url ?: "")
                suggesting = false
                if (tags.isNotEmpty()) {
                    suggested = tags
                    selected = tags
                    repo.updateTags(created.file, tags)
                }
            }
        }
    }

    fun save() {
        val p = preview ?: return
        scope.launch {
            repo.updateTags(p.file, selected)
            repo.reconcile()
            onExit()
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Add bookmark", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = onExit) { Icon(Icons.Filled.Close, "Exit add", modifier = Modifier.size(20.dp)) }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                placeholder = { Text("Paste a URL and press Enter…") },
                singleLine = true,
                enabled = !loading,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (preview != null) save() else fetch() }),
                modifier = Modifier.weight(1f).focusRequester(focus),
            )
            if (loading) {
                androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(20.dp).padding(start = 8.dp))
            } else if (preview == null) {
                TextButton(onClick = { fetch() }, enabled = url.isNotBlank()) { Text("Fetch") }
            }
        }

        preview?.let { p ->
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(p.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                p.description?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
                p.url?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis) }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Tags", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (suggested.isNotEmpty()) {
                        Icon(Icons.Filled.AutoAwesome, null, modifier = Modifier.size(12.dp), tint = MaterialTheme.colorScheme.primary)
                        Text("AI suggested", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                    if (suggesting) androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(12.dp))
                }
                // Selected tags (accent).
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (tag in selected.filter { it != "status/active" }) {
                        Row(
                            Modifier.clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.primaryContainer)
                                .clickable { selected = selected - tag }
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(tag, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
                            Icon(Icons.Filled.Close, null, modifier = Modifier.size(12.dp))
                        }
                    }
                }
                // Suggested-but-unselected (gray, +).
                val unselected = suggested.filter { it !in selected && it != "status/active" }
                if (unselected.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (tag in unselected) {
                            Row(
                                Modifier.clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
                                    .clickable { selected = selected + tag }
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Icon(Icons.Filled.Add, null, modifier = Modifier.size(12.dp))
                                Text(tag, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
                // Custom tag input + autocomplete.
                val customSug = remember(customInput, allTags, selected) {
                    tagSuggestions(allTags, customInput, selected.toSet(), 6)
                }
                OutlinedTextField(
                    value = customInput,
                    onValueChange = { customInput = it },
                    placeholder = { Text("Add tag…") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val pick = customSug.firstOrNull() ?: customInput.trim()
                        if (pick.isNotBlank() && pick !in selected) selected = selected + pick
                        customInput = ""
                    }),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (customInput.isNotBlank() && customSug.isNotEmpty()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (s in customSug) {
                            TextButton(onClick = { if (s !in selected) selected = selected + s; customInput = "" }) {
                                Text(s, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
                TextButton(
                    onClick = { save() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.Check, null, modifier = Modifier.size(16.dp))
                    Text("  Save bookmark")
                }
            }
        } ?: run {
            if (loading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(24.dp))
                        Text("Fetching page info…", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 8.dp))
                    }
                }
            } else {
                Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(
                        "Paste a URL and press Enter.\nMetadata and tags will be suggested automatically.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

// --- Triage mode --- //

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BookmarkTriageScreen(
    repo: BookmarksRepository,
    bookmarks: List<BookmarkRow>,
    tagsByFile: Map<String, List<String>>,
    searchQuery: String,
    selectedTag: String?,
    allTags: List<String>,
    onExit: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var index by remember { mutableStateOf(0) }
    var body by remember { mutableStateOf<String?>(null) }

    // Recompute the queue from the (mutating) bookmark list each recomposition.
    val filtered = remember(bookmarks, searchQuery, selectedTag, tagsByFile) {
        filterBookmarks(bookmarks, tagsByFile, searchQuery, selectedTag)
    }
    val current = filtered.getOrNull(index)

    LaunchedEffect(current?.file) {
        body = null
        current?.let { body = repo.fetchDetail(it.file)?.body }
    }

    if (current == null) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text("All done!", style = MaterialTheme.typography.titleMedium)
            Text("Reviewed all bookmarks in this queue.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onExit) { Text("Back to browse") }
        }
        return
    }

    val progress = if (filtered.isNotEmpty()) (index + 1).toFloat() / filtered.size else 0f
    val tags = tagsByFile[current.file] ?: emptyList()

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.weight(1f))
            Text("${index + 1} / ${filtered.size}", style = MaterialTheme.typography.labelSmall)
            IconButton(onClick = onExit) { Icon(Icons.Filled.Close, "Exit triage", modifier = Modifier.size(18.dp)) }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(current.title, style = MaterialTheme.typography.titleMedium)
            current.url?.let { u ->
                Row(
                    Modifier.clickable { openBookmark(ctx, u) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(bookmarkDomain(u), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, null, modifier = Modifier.size(11.dp), tint = MaterialTheme.colorScheme.primary)
                }
            }
            current.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TagEditor(
                tags = tags,
                allTags = allTags,
                onAdd = { tag ->
                    if (tag.isNotBlank() && tag !in tags) scope.launch { repo.updateTags(current.file, tags + tag) }
                },
                onRemove = { tag -> scope.launch { repo.updateTags(current.file, tags - tag) } },
            )
            body?.let {
                Column {
                    Text("Notes", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        // Actions: Delete / Skip / Keep.
        Row(Modifier.fillMaxWidth().height(52.dp)) {
            TriageAction("Delete", MaterialTheme.colorScheme.error, Modifier.weight(1f)) {
                val file = current.file
                scope.launch {
                    repo.delete(file)
                    // index stays; next item slides in. Clamp handled by getOrNull.
                }
            }
            TriageAction("Skip", MaterialTheme.colorScheme.onSurface, Modifier.weight(1f)) {
                index += 1
            }
            TriageAction("Keep", MaterialTheme.colorScheme.primary, Modifier.weight(1f)) {
                index += 1
            }
        }
    }
}

@Composable
private fun TriageAction(label: String, color: Color, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium, color = color)
    }
}

private fun openBookmark(ctx: android.content.Context, url: String) {
    runCatching {
        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    }
}

// ---------------------------------------------------------------------- //
// Music — Spotify remote (online-only)
// ---------------------------------------------------------------------- //

@Composable
fun MusicScreen(repo: MusicRepository, onGrid: () -> Unit = {}) {
    val state by repo.state.collectAsState()
    val playlists by repo.playlists.collectAsState()
    val lastError by repo.lastError.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var volume by remember { mutableStateOf<Float?>(null) }
    var seeking by remember { mutableStateOf<Float?>(null) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<MusicRepository.SearchTrack>>(emptyList()) }
    // 1s ticker so the progress bar interpolates smoothly between polls.
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    val searchFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        repo.loadPlaylists()
        while (true) {
            repo.refresh()
            kotlinx.coroutines.delay(5000)
        }
    }
    LaunchedEffect(Unit) {
        while (true) { kotlinx.coroutines.delay(1000); nowTick = System.currentTimeMillis() }
    }
    LaunchedEffect(searchQuery) {
        kotlinx.coroutines.delay(350)
        searchResults = if (searchQuery.trim().length >= 2) repo.search(searchQuery) else emptyList()
    }
    // Surface control errors as a toast.
    LaunchedEffect(lastError) {
        lastError?.let {
            android.widget.Toast.makeText(ctx, it, android.widget.Toast.LENGTH_LONG).show()
            repo.clearError()
        }
    }
    // Re-check liked whenever the current track id changes.
    LaunchedEffect(state?.trackId) { /* refresh already sets liked per track */ }

    val np = state

    // Not linked → Connect button.
    if (np != null && !np.linked) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Filled.MusicNote, null, modifier = Modifier.size(36.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Spotify isn't linked yet.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 8.dp))
            TextButton(onClick = {
                openMusicUrl(ctx, io.amar.console.core.HubConfig.hubBase + "/auth/spotify/start")
            }) { Text("Connect Spotify") }
        }
        return
    }
    if (np == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Music remote needs the hub", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Zero-devices warning.
        if (np.devices.isEmpty()) {
            Text(
                "No playback device. Open Spotify, pick amarhp-spotifyd in the Connect menu and press play, then try again.",
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFFF59E0B),
                modifier = Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0x1AF59E0B))
                    .padding(10.dp),
            )
        }

        // Album art + music-note placeholder.
        Box(
            Modifier.size(200.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            if (np.albumArt != null) {
                AsyncImage(model = np.albumArt, contentDescription = null, modifier = Modifier.fillMaxSize())
            } else {
                Icon(Icons.Filled.MusicNote, null, modifier = Modifier.size(48.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(np.track ?: "Nothing playing", style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (np.artist.isNotBlank()) {
                Text(np.artist, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = { scope.launch { repo.toggleLike() } }, enabled = np.trackId != null) {
                Icon(
                    if (np.liked == true) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    contentDescription = if (np.liked == true) "Remove from Liked Songs" else "Save to Liked Songs",
                    modifier = Modifier.size(20.dp),
                    tint = if (np.liked == true) Color(0xFFF87171) else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (np.durationMs > 0) {
            // Interpolate progress between polls while playing (1s ticker drives recompute).
            val liveProgress = if (np.isPlaying) {
                (np.progressMs + (nowTick - np.fetchedAt)).coerceIn(0L, np.durationMs)
            } else np.progressMs
            Slider(
                value = seeking ?: (liveProgress.toFloat() / np.durationMs).coerceIn(0f, 1f),
                onValueChange = { seeking = it },
                onValueChangeFinished = {
                    val fraction = seeking ?: return@Slider
                    scope.launch { repo.seek((fraction * np.durationMs).toLong()) }
                    seeking = null
                },
                enabled = seekAllowed(np.disallows),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatMs(seeking?.let { (it * np.durationMs).toLong() } ?: liveProgress), style = MaterialTheme.typography.labelSmall)
                Text(formatMs(np.durationMs), style = MaterialTheme.typography.labelSmall)
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { scope.launch { repo.setShuffle(!np.shuffle) } }, enabled = shuffleAllowed(np.disallows)) {
                Icon(
                    Icons.Filled.Shuffle, "Shuffle", modifier = Modifier.size(22.dp),
                    tint = if (np.shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { scope.launch { repo.prev() } }) {
                Icon(Icons.Filled.SkipPrevious, "Previous", modifier = Modifier.size(32.dp))
            }
            IconButton(onClick = { scope.launch { repo.toggle() } }) {
                Icon(
                    if (np.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    if (np.isPlaying) "Pause" else "Play",
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            IconButton(onClick = { scope.launch { repo.next() } }) {
                Icon(Icons.Filled.SkipNext, "Next", modifier = Modifier.size(32.dp))
            }
            IconButton(onClick = { scope.launch { repo.cycleRepeat() } }, enabled = repeatAllowed(np.disallows)) {
                Icon(
                    if (np.repeat == "track") Icons.Filled.RepeatOne else Icons.Filled.Repeat,
                    "Repeat: ${np.repeat}",
                    modifier = Modifier.size(22.dp),
                    tint = if (np.repeat != "off") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        np.volumePercent?.let { pct ->
            Slider(
                value = volume ?: (pct / 100f),
                onValueChange = { volume = it },
                onValueChangeFinished = {
                    val v = ((volume ?: return@Slider) * 100).toInt()
                    scope.launch { repo.volume(v) }
                    volume = null
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // Device row + transfer to spotifyd.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Filled.Cast, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                np.device ?: "No active device",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val onOther = np.spotifydDeviceId != null && np.device != null &&
                np.devices.firstOrNull { it.isActive }?.id != np.spotifydDeviceId
            if (onOther) {
                TextButton(onClick = { np.spotifydDeviceId?.let { id -> scope.launch { repo.transfer(id) } } }) {
                    Text("→ spotifyd", style = MaterialTheme.typography.labelSmall)
                }
            }
        }

        // Search-to-play.
        OutlinedTextField(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            placeholder = { Text("Search & play…") },
            leadingIcon = { Icon(Icons.Filled.Search, null, modifier = Modifier.size(18.dp)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().focusRequester(searchFocus),
        )
        for (track in searchResults) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                MusicThumb(track.albumArt)
                Column(Modifier.weight(1f).clickable { scope.launch { repo.playUri(track.uri) } }) {
                    Text(track.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(track.artists, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = { scope.launch { repo.queueUri(track.uri) } }) {
                    Icon(Icons.Filled.PlaylistAdd, "Add to queue", modifier = Modifier.size(20.dp))
                }
            }
        }

        // Library — Liked Songs + playlists.
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Library", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(
                Modifier.fillMaxWidth().clickable { scope.launch { repo.playLiked() } }.padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(40.dp).clip(RoundedCornerShape(4.dp)).background(Color(0xFF7C3AED)),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Favorite, null, tint = Color.White, modifier = Modifier.size(18.dp)) }
                Text("Liked Songs", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            }
            if (playlists.isNotEmpty()) {
                Text("Playlists", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
            for (p in playlists) {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MusicThumb(p.image)
                    Column(Modifier.weight(1f).clickable { scope.launch { repo.playUri(p.uri) } }) {
                        Text(p.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${p.trackCount} tracks", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(
                        onClick = { scope.launch { repo.addCurrentToPlaylist(p.id) } },
                        enabled = np.trackUri != null,
                    ) { Icon(Icons.Filled.Add, "Add current track", modifier = Modifier.size(18.dp)) }
                }
            }
        }
    }
}

@Composable
private fun MusicThumb(url: String?) {
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (url != null) AsyncImage(model = url, contentDescription = null, modifier = Modifier.fillMaxSize())
        else Icon(Icons.Filled.MusicNote, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun openMusicUrl(ctx: android.content.Context, url: String) {
    runCatching {
        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    }
}

private fun formatMs(ms: Long): String {
    val totalSec = ms / 1000
    return "%d:%02d".format(totalSec / 60, totalSec % 60)
}

// Saver shared with the feeds tree state.
private val stringSetSaver = androidx.compose.runtime.saveable.Saver<Set<String>, String>(
    save = { it.joinToString("\n") },
    restore = { if (it.isEmpty()) emptySet() else it.split("\n").toSet() },
)
