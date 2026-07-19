package io.amar.console.ui.notes

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.notes.Fuzzy
import io.amar.console.data.notes.NotesRepository
import io.amar.console.data.notes.PenPage
import io.amar.console.data.notes.slugify
import io.amar.console.ui.agents.MarkdownLite
import kotlinx.coroutines.launch

/**
 * Notes: directory browser (+ quick switcher, full-text search, create FAB,
 * long-press rename/delete) over the cached vault listing, and an editor with
 * View (MarkdownLite) / Edit toggle, conflict banner, and a pen-page viewer
 * for scratch/pen/ *.svg handwriting pages.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NotesBrowserScreen(repo: NotesRepository, onOpenFile: (String) -> Unit, onGrid: () -> Unit = {}) {
    val files by repo.observeFiles().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var currentDir by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var showCreate by remember { mutableStateOf(false) }
    var actionTarget by remember { mutableStateOf<NoteFileRow?>(null) }
    var renameTarget by remember { mutableStateOf<NoteFileRow?>(null) }
    var deleteTarget by remember { mutableStateOf<NoteFileRow?>(null) }

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
                IconButton(onClick = { searching = true }) {
                    Icon(Icons.Filled.Search, "Search notes")
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
            onDismiss = { searching = false },
            onOpen = { path -> searching = false; onOpenFile(path) },
        )
    }

    if (showCreate) {
        CreateNoteDialog(
            currentDir = currentDir,
            onDismiss = { showCreate = false },
            onCreate = { path ->
                showCreate = false
                scope.launch { repo.create(path) }
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
                scope.launch { repo.rename(file.path, to) }
            },
        )
    }

    deleteTarget?.let { file ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete note?") },
            text = { Text(file.path) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { repo.delete(file.path) }
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
private fun NotesQuickSwitcher(
    repo: NotesRepository,
    files: List<NoteFileRow>,
    onDismiss: () -> Unit,
    onOpen: (String) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var contentMode by remember { mutableStateOf(false) }
    var contentResults by remember { mutableStateOf<List<NoteFileRow>>(emptyList()) }

    // Full-text: re-query cached bodies as the query changes.
    LaunchedEffect(query, contentMode) {
        if (contentMode && query.isNotBlank()) {
            contentResults = repo.searchContent(query.trim())
        }
    }

    val filenameResults = remember(files, query) {
        val sorted = files.sortedByDescending { it.mtime }
        Fuzzy.filter(sorted, query) { it.path }.take(30)
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
                        label = { Text(if (contentMode) "Search content" else "Find file") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { contentMode = !contentMode }) {
                        Text(if (contentMode) "text" else "file", style = MaterialTheme.typography.labelMedium)
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
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
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
private fun CreateNoteDialog(currentDir: String, onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var title by remember { mutableStateOf("") }
    val slug = remember(title) { slugify(title) }
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
                if (slug.isNotEmpty()) {
                    Text(
                        (if (currentDir.isEmpty()) "" else "$currentDir/") + "$slug.md",
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
                    val path = (if (currentDir.isEmpty()) "" else "$currentDir/") + "$slug.md"
                    onCreate(path)
                },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

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

// ------------------------------------------------------------------ //
// Editor: View (MarkdownLite) / Edit toggle + conflict banner + pen viewer.

@Composable
fun NoteEditorScreen(repo: NotesRepository, path: String, onBack: () -> Unit) {
    if (PenPage.isPenPagePath(path)) {
        PenPageScreen(repo, path, onBack)
        return
    }

    val row by repo.observeFile(path).collectAsState(initial = null)
    val conflicts by repo.observeConflict(path).collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf<String?>(null) }
    var edited by remember { mutableStateOf(false) }
    var viewMode by remember { mutableStateOf(true) }

    LaunchedEffect(path) {
        text = repo.openFile(path)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text(
                path.substringAfterLast('/').removeSuffix(".md") + if (edited) " *" else "",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (row?.dirty == true) {
                Text("queued", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
            IconButton(onClick = { viewMode = !viewMode }) {
                Icon(
                    if (viewMode) Icons.Filled.Edit else Icons.Outlined.Visibility,
                    if (viewMode) "Edit" else "View",
                )
            }
            IconButton(
                onClick = {
                    val t = text ?: return@IconButton
                    scope.launch { repo.save(path, t) }
                    edited = false
                },
                enabled = edited,
            ) { Icon(Icons.Filled.Save, "Save", tint = if (edited) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        if (conflicts.isNotEmpty()) {
            ConflictBanner(
                onKeepMine = {
                    val t = text ?: return@ConflictBanner
                    scope.launch { repo.resolveKeepMine(path, t) }
                },
                onTakeServer = {
                    scope.launch {
                        repo.resolveTakeServer(path)
                        text = repo.openFile(path)
                        edited = false
                    }
                },
            )
        }
        when (val t = text) {
            null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (row == null) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                else Text("Not cached — connect once to fetch", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> if (viewMode) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
                ) {
                    MarkdownLite(t)
                }
            } else {
                OutlinedTextField(
                    value = t,
                    onValueChange = { text = it; edited = true },
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                )
            }
        }
    }
}

@Composable
private fun ConflictBanner(onKeepMine: () -> Unit, onTakeServer: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(
            "Edited elsewhere while offline — pick a copy",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onKeepMine) { Text("Keep mine") }
            TextButton(onClick = onTakeServer) { Text("Take server") }
        }
    }
}

// ------------------------------------------------------------------ //
// Pen-page viewer: scratch/pen/ *.svg handwriting from the Neo pen.

@Composable
private fun PenPageScreen(repo: NotesRepository, initialPath: String, onBack: () -> Unit) {
    val files by repo.observeFiles().collectAsState(initial = emptyList())
    var path by remember { mutableStateOf(initialPath) }
    var doc by remember { mutableStateOf<io.amar.console.data.notes.PenPageDoc?>(null) }
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(path) {
        loaded = false
        doc = repo.openFile(path)?.let { PenPage.parse(it) }
        loaded = true
    }

    val siblings = remember(files, path) { PenPage.siblingPages(path, files.map { it.path }) }
    val index = siblings.indexOf(path)
    val label = remember(path) {
        val note = path.substringBeforeLast('/').substringAfterLast('/')
        val page = PenPage.pageNumber(path)
        if (page != null) "$note · page $page" else path.substringAfterLast('/')
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text(
                label,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            IconButton(
                onClick = { if (index > 0) path = siblings[index - 1] },
                enabled = index > 0,
            ) { Icon(Icons.Filled.ChevronLeft, "Previous page") }
            IconButton(
                onClick = { if (index in 0 until siblings.size - 1) path = siblings[index + 1] },
                enabled = index in 0 until siblings.size - 1,
            ) { Icon(Icons.Filled.ChevronRight, "Next page") }
        }
        val d = doc
        when {
            !loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            }
            d == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No pen strokes in this page", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> PenPageCanvas(d, Modifier.fillMaxSize().padding(8.dp))
        }
    }
}

@Composable
private fun PenPageCanvas(doc: io.amar.console.data.notes.PenPageDoc, modifier: Modifier = Modifier) {
    Canvas(modifier.background(Color(0xFF141414))) {
        if (doc.viewW <= 0f || doc.viewH <= 0f) return@Canvas
        // Fit the Ncode page rect into the canvas, preserving aspect.
        val scale = minOf(size.width / doc.viewW, size.height / doc.viewH)
        val offX = (size.width - doc.viewW * scale) / 2f
        val offY = (size.height - doc.viewH * scale) / 2f
        fun tx(x: Float) = offX + (x - doc.viewX) * scale
        fun ty(y: Float) = offY + (y - doc.viewY) * scale

        for (stroke in doc.strokes) {
            val dots = stroke.dots
            if (dots.isEmpty()) continue
            if (dots.size == 1) {
                drawCircle(Color.White, radius = 1.5f, center = androidx.compose.ui.geometry.Offset(tx(dots[0].x), ty(dots[0].y)))
                continue
            }
            val p = Path()
            p.moveTo(tx(dots[0].x), ty(dots[0].y))
            for (i in 1 until dots.size) p.lineTo(tx(dots[i].x), ty(dots[i].y))
            drawPath(p, Color.White, style = Stroke(width = 2f))
        }
    }
}
