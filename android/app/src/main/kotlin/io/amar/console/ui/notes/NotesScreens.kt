package io.amar.console.ui.notes

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.BubbleChart
import androidx.compose.material.icons.filled.ManageSearch
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.notes.Fuzzy
import io.amar.console.data.notes.NotesRepository
import io.amar.console.data.notes.slugify
import kotlinx.coroutines.launch

/**
 * Notes browser: directory drill-down over the cached vault listing with a
 * quick switcher (filename + content), create FAB (title + directory picker
 * with recency autocomplete), long-press rename/delete. The editor lives in
 * NoteEditor.kt; the pen-page viewer in PenPageScreen.kt.
 */
enum class NotesViewMode { TREE, CIRCLES, BLOG }

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NotesBrowserScreen(repo: NotesRepository, onOpenFile: (String) -> Unit, onGrid: () -> Unit = {}) {
    val files by repo.observeFiles().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("notes_view", android.content.Context.MODE_PRIVATE) }
    var viewMode by remember {
        mutableStateOf(runCatching { NotesViewMode.valueOf(prefs.getString("viewMode", "TREE")!!) }.getOrDefault(NotesViewMode.TREE))
    }
    fun setViewMode(m: NotesViewMode) { viewMode = m; prefs.edit().putString("viewMode", m.name).apply() }
    var currentDir by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var searchMode by remember { mutableStateOf(false) } // false = filename, true = content
    var showCreate by remember { mutableStateOf(false) }
    var actionTarget by remember { mutableStateOf<NoteFileRow?>(null) }
    var renameTarget by remember { mutableStateOf<NoteFileRow?>(null) }
    var deleteTarget by remember { mutableStateOf<NoteFileRow?>(null) }
    val accent = MaterialTheme.colorScheme.primary

    // Wire the SyncBus 'pen' service once (red-dot + auto-open live page). The
    // AppGraph doesn't own this wiring, so the Notes pane self-arms it on mount
    // (idempotent). Auto-open the pen's live page when arriving on the pane and
    // a stroke landed in the last 60s.
    val penActivePath by repo.penActivePagePath.collectAsState()
    val penActiveAt by repo.penActiveAt.collectAsState()
    LaunchedEffect(Unit) {
        repo.wirePenActivity(scope)
        val p = penActivePath
        if (p != null && System.currentTimeMillis() - penActiveAt < 60_000) {
            repo.clearPenActivity()
            onOpenFile(p)
        }
    }

    // Non-tree views render full-screen (blog/circles) with their own chrome.
    if (viewMode == NotesViewMode.BLOG) {
        Column(Modifier.fillMaxSize()) {
            ViewModeBar(viewMode, onMode = { setViewMode(it) }, onRescan = { scope.launch { repo.reconcile() } })
            BlogView(repo, onOpenFile = onOpenFile, modifier = Modifier.weight(1f))
        }
        return
    }
    if (viewMode == NotesViewMode.CIRCLES) {
        Column(Modifier.fillMaxSize()) {
            ViewModeBar(viewMode, onMode = { setViewMode(it) }, onRescan = { scope.launch { repo.reconcile() } })
            CirclesView(
                files = files,
                accent = accent,
                onOpenFile = onOpenFile,
                onMove = { from, toDir ->
                    val to = (if (toDir.isEmpty() || toDir == CirclesLayoutRoot) "" else "$toDir/") + from.substringAfterLast('/')
                    scope.launch { repo.rename(from, to); repo.tabs.renamed(from, to) }
                },
                modifier = Modifier.weight(1f),
            )
        }
        return
    }

    val dirs = remember(files, currentDir) {
        files.asSequence()
            .filter { it.dir.startsWith(currentDir) && it.dir != currentDir }
            .map { it.dir.removePrefix(if (currentDir.isEmpty()) "" else "$currentDir/").substringBefore('/') }
            .filter { it.isNotEmpty() }
            .distinct()
            .sorted()
            .toList()
    }
    val filesHere = remember(files, currentDir) {
        files.filter { it.dir == currentDir }.sortedByDescending { it.mtime }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (currentDir.isNotEmpty()) {
                    IconButton(onClick = {
                        currentDir = currentDir.substringBeforeLast('/', "")
                    }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Up") }
                }
                Text(
                    if (currentDir.isEmpty()) "Vault" else currentDir,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { searchMode = false; searching = true }) {
                    Icon(Icons.Filled.Search, "Find file")
                }
                IconButton(onClick = { searchMode = true; searching = true }) {
                    Icon(Icons.Filled.ManageSearch, "Search in files")
                }
                IconButton(onClick = { scope.launch { repo.reconcile() } }) {
                    Icon(Icons.Filled.Refresh, "Rescan vault")
                }
                IconButton(onClick = { setViewMode(NotesViewMode.CIRCLES) }) {
                    Icon(Icons.Filled.BubbleChart, "Circles view")
                }
                IconButton(onClick = { setViewMode(NotesViewMode.BLOG) }) {
                    Icon(Icons.Filled.MenuBook, "Blog view")
                }
            }
            if (files.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("No cached listing yet — connect once", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(dirs, key = { "dir-$it" }) { dir ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { currentDir = if (currentDir.isEmpty()) dir else "$currentDir/$dir" }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.Folder, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                            Text(dir, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    items(filesHere, key = { it.path }) { file ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .combinedClickable(
                                    onClick = { onOpenFile(file.path) },
                                    onLongClick = { actionTarget = file },
                                )
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Description, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                            Text(
                                file.name.removeSuffix(".md"),
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (file.cachedContent != null) {
                                Icon(
                                    Icons.Filled.Circle, contentDescription = "Cached offline",
                                    tint = if (file.dirty) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(6.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
        FloatingActionButton(
            onClick = { showCreate = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) { Icon(Icons.Filled.Add, "New note") }
    }

    if (searching) {
        NotesQuickSwitcher(
            repo = repo,
            files = files,
            initialContentMode = searchMode,
            onDismiss = { searching = false },
            onOpen = { path -> searching = false; onOpenFile(path) },
        )
    }

    if (showCreate) {
        CreateNoteDialog(
            repo = repo,
            currentDir = currentDir,
            onDismiss = { showCreate = false },
            onCreate = { path, seed ->
                showCreate = false
                scope.launch { repo.create(path, seed) }
                onOpenFile(path)
            },
        )
    }

    actionTarget?.let { file ->
        NoteActionsSheet(
            file = file,
            onDismiss = { actionTarget = null },
            onRename = { actionTarget = null; renameTarget = file },
            onDelete = { actionTarget = null; deleteTarget = file },
        )
    }

    renameTarget?.let { file ->
        RenameNoteDialog(
            file = file,
            onDismiss = { renameTarget = null },
            onRename = { to ->
                renameTarget = null
                scope.launch {
                    repo.rename(file.path, to)
                    repo.tabs.renamed(file.path, to)
                }
            },
        )
    }

    deleteTarget?.let { file ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete \"${file.name.removeSuffix(".md")}\"?") },
            text = { Text(file.path) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        repo.delete(file.path)
                        repo.tabs.close(file.path, force = true)
                    }
                    deleteTarget = null
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("Cancel") } },
        )
    }
}

// ------------------------------------------------------------------ //
// Quick switcher: fuzzy filename + full-text content search.

@Composable
internal fun NotesQuickSwitcher(
    repo: NotesRepository,
    files: List<NoteFileRow>,
    initialContentMode: Boolean = false,
    onDismiss: () -> Unit,
    onOpen: (String) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var contentMode by remember { mutableStateOf(initialContentMode) }
    var contentResults by remember { mutableStateOf<List<NoteFileRow>>(emptyList()) }

    LaunchedEffect(query, contentMode) {
        if (contentMode && query.isNotBlank()) {
            contentResults = repo.searchContent(query.trim())
        }
    }

    val filenameResults = remember(files, query) {
        if (query.isBlank()) files.sortedByDescending { it.mtime }.take(30)
        else Fuzzy.rank(files, query, limit = 50) { it.path }.map { it.item }
    }
    val results = if (contentMode) contentResults else filenameResults

    AlertDialog(
        onDismissRequest = onDismiss,
        title = null,
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedTextField(
                        value = query, onValueChange = { query = it },
                        label = { Text(if (contentMode) "Search in files" else "Find file") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { contentMode = !contentMode }) {
                        Text(if (contentMode) "content" else "file", style = MaterialTheme.typography.labelMedium)
                    }
                }
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.fillMaxWidth().height(340.dp)) {
                    items(results, key = { it.path }) { f ->
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clickable { onOpen(f.path) }
                                .padding(vertical = 6.dp),
                        ) {
                            Text(
                                f.name.removeSuffix(".md"),
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                f.dir.ifEmpty { "/" },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            if (contentMode) {
                                val snippet = remember(f.path, query) { contentSnippet(f.cachedContent, query) }
                                if (snippet != null) {
                                    Text(
                                        snippet,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                    if (contentMode && query.isNotBlank() && results.isEmpty()) {
                        item {
                            Text(
                                "No matches in offline-cached notes",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 12.dp),
                            )
                        }
                    } else if (contentMode && query.isBlank()) {
                        item {
                            Text(
                                "Type to search across all files",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 12.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

internal const val CirclesLayoutRoot = "__root__"

/** Toolbar for the blog / circles views: switch back to tree/other + rescan. */
@Composable
private fun ViewModeBar(current: NotesViewMode, onMode: (NotesViewMode) -> Unit, onRescan: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (current == NotesViewMode.BLOG) "Blog" else "Circles",
            style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onRescan) { Icon(Icons.Filled.Refresh, "Rescan vault") }
        if (current != NotesViewMode.CIRCLES) IconButton(onClick = { onMode(NotesViewMode.CIRCLES) }) { Icon(Icons.Filled.BubbleChart, "Circles view") }
        if (current != NotesViewMode.BLOG) IconButton(onClick = { onMode(NotesViewMode.BLOG) }) { Icon(Icons.Filled.MenuBook, "Blog view") }
        IconButton(onClick = { onMode(NotesViewMode.TREE) }) { Icon(Icons.Filled.AccountTree, "Tree view") }
    }
}

/** Matching line + a little context (SPA switcher parity). */
internal fun contentSnippet(content: String?, query: String): String? {
    content ?: return null
    val q = query.trim().lowercase()
    if (q.isEmpty()) return null
    val lines = content.lines()
    val idx = lines.indexOfFirst { it.lowercase().contains(q) }
    if (idx < 0) return null
    return lines.subList(maxOf(0, idx), minOf(lines.size, idx + 2)).joinToString(" · ").take(160)
}

// ------------------------------------------------------------------ //
// Create / rename dialogs + long-press sheet

@Composable
private fun CreateNoteDialog(
    repo: NotesRepository,
    currentDir: String,
    onDismiss: () -> Unit,
    onCreate: (path: String, seed: String) -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var dir by remember { mutableStateOf(currentDir) }
    var dirFocused by remember { mutableStateOf(false) }
    val slug = remember(title) { slugify(title) }
    var recentDirs by remember { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(Unit) { recentDirs = repo.directoriesByRecency() }

    val suggestions = remember(dir, recentDirs) {
        val q = dir.trim()
        if (q.isEmpty()) recentDirs.take(8)
        else recentDirs.filter { it.contains(q, ignoreCase = true) && it != q }.take(8)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New note") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(
                    value = title, onValueChange = { title = it },
                    label = { Text("Title") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = dir, onValueChange = { dir = it },
                    label = { Text("Directory (empty = root)") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                        .onFocusChangedCompat { dirFocused = it },
                )
                if (dirFocused && suggestions.isNotEmpty()) {
                    Column(
                        Modifier.fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)),
                    ) {
                        for (s in suggestions) {
                            Row(
                                Modifier.fillMaxWidth().clickable { dir = s }
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(s, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                                if (s == "scratch") {
                                    Text("default", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
                if (slug.isNotEmpty()) {
                    Text(
                        (if (dir.trim().isEmpty()) "" else "${dir.trim().trimEnd('/')}/") + "$slug.md",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = slug.isNotEmpty(),
                onClick = {
                    val d = dir.trim().trimEnd('/')
                    val path = (if (d.isEmpty()) "" else "$d/") + "$slug.md"
                    onCreate(path, "# ${title.trim()}\n\n")
                },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** onFocusChanged that only fires the boolean (avoids importing FocusState at call sites). */
private fun Modifier.onFocusChangedCompat(onChange: (Boolean) -> Unit): Modifier =
    this.onFocusChanged { onChange(it.isFocused) }

@Composable
private fun RenameNoteDialog(file: NoteFileRow, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    var name by remember { mutableStateOf(file.name.removeSuffix(".md")) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename note") },
        text = {
            OutlinedTextField(
                value = name, onValueChange = { name = it },
                label = { Text("Name") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank() && name.trim() != file.name.removeSuffix(".md"),
                onClick = {
                    val ext = if (file.name.contains('.')) "." + file.name.substringAfterLast('.') else ""
                    val to = (if (file.dir.isEmpty()) "" else "${file.dir}/") + name.trim() + ext
                    onRename(to)
                },
            ) { Text("Rename") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoteActionsSheet(
    file: NoteFileRow,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            file.name,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onRename).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Outlined.DriveFileRenameOutline, null, Modifier.size(20.dp))
            Text("Rename", style = MaterialTheme.typography.bodyMedium)
        }
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onDelete).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Filled.Delete, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.error)
            Text("Delete", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(24.dp))
    }
}
