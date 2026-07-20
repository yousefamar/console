package io.amar.console.ui.notes

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.StrikethroughS
import androidx.compose.material.icons.filled.Superscript
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.core.Dictation
import io.amar.console.data.notes.EditorActions
import io.amar.console.data.notes.FrontmatterParser
import io.amar.console.data.notes.NotesRepository
import io.amar.console.data.notes.PenPage
import kotlinx.coroutines.launch

/**
 * Notes editor. Multi-file tab bar (dirty dots + close guards), View/Edit
 * toggle with the notes markdown renderer, a markdown formatting toolbar
 * (bold/italic/strike/code/link/footnote/image/dictate) operating on the live
 * selection, a command palette, link picker, image insert, and the writing-
 * mode chrome (WriteMetaBar + WriteActionBar + publish flow) for blog files.
 * Delegates pen pages to PenPageScreen.
 */
@Composable
fun NoteEditorScreen(
    repo: NotesRepository,
    path: String,
    onBack: () -> Unit,
    agents: io.amar.console.data.agents.AgentsRepository? = null,
    onOpenAgentSession: (String) -> Unit = {},
    mirror: io.amar.console.glasses.mirror.GlassesMirror? = null,
) {
    if (PenPage.isPenPagePath(path)) {
        PenPageScreen(repo, path, onBack)
        return
    }

    val files by repo.observeFiles().collectAsState(initial = emptyList())
    val tabState by repo.tabs.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // The tab shown is the active one; opening [path] from nav adds/activates it.
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(path) {
        loading = true
        val content = repo.openFile(path) ?: ""
        repo.tabs.open(path, content)
        loading = false
    }

    val activePath = tabState.activePath ?: path
    val activeTab = tabState.activeTab
    val conflicts by repo.observeConflict(activePath).collectAsState(initial = emptyList())
    val row by repo.observeFile(activePath).collectAsState(initial = null)

    var viewMode by remember { mutableStateOf(true) }
    var tfv by remember(activePath) { mutableStateOf(TextFieldValue(activeTab?.content ?: "")) }
    // Keep the TextFieldValue in sync when the active tab's content is replaced
    // externally (tab switch, conflict resolve).
    LaunchedEffect(activePath, activeTab?.content) {
        val c = activeTab?.content ?: ""
        if (tfv.text != c) tfv = tfv.copy(text = c, selection = TextRange(minOf(tfv.selection.end, c.length)))
    }

    var showPalette by remember { mutableStateOf(false) }
    var linkPicker by remember { mutableStateOf<LinkPickerRequest?>(null) }
    var closeConfirm by remember { mutableStateOf<String?>(null) }
    var vimEnabled by remember { mutableStateOf(false) }
    var projectPanelSlug by remember { mutableStateOf<String?>(null) }

    // Push the doc + cursor to the glasses notes mirror (cursor-follow window).
    fun pushEditorMirror(v: TextFieldValue) {
        val m = mirror ?: return
        val caret = v.selection.start.coerceIn(0, v.text.length)
        val before = v.text.substring(0, caret)
        val cursorLine = before.count { it == '\n' } + 1
        val cursorCol = caret - (before.lastIndexOf('\n') + 1)
        m.setEditorCursor(
            io.amar.console.glasses.mirror.GlassesMirror.EditorSnapshot(
                path = activePath,
                lines = v.text.split('\n'),
                cursorLine = cursorLine,
                cursorCol = cursorCol,
            )
        )
    }

    // Push live edits into the tab model (drives the dirty dot).
    fun applyEdit(newTfv: TextFieldValue) {
        tfv = newTfv
        repo.tabs.setContent(activePath, newTfv.text)
        pushEditorMirror(newTfv)
    }

    // Feed the glasses notes mirror on tab switch; clear it when the editor
    // leaves composition (mirror falls back to the pane status line).
    LaunchedEffect(activePath) { pushEditorMirror(tfv) }
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose { mirror?.setEditorCursor(null) }
    }

    fun applyAction(edit: EditorActions.Edit) {
        applyEdit(TextFieldValue(edit.text, TextRange(edit.selStart, edit.selEnd)))
    }

    fun save(p: String = activePath) {
        val content = repo.tabs.state.value.tab(p)?.content ?: return
        scope.launch { repo.save(p, content); repo.tabs.markSaved(p, content) }
    }

    // Image insert pipeline (picker → downscale → upload → embed).
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            insertImageFromUri(context, repo, uri, tfv) { edit -> applyAction(edit) }
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        // Tab bar.
        NoteTabBar(
            tabs = tabState.open,
            activePath = activePath,
            onSelect = { p -> repo.tabs.setActive(p) },
            onClose = { p ->
                if (!repo.tabs.close(p)) closeConfirm = p
            },
            onBack = onBack,
        )

        // Toolbar row: view/edit toggle, formatting, save, palette.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { viewMode = !viewMode }) {
                Icon(if (viewMode) Icons.Filled.Edit else Icons.Outlined.Visibility, if (viewMode) "Edit" else "View")
            }
            if (!viewMode) {
                ToolbarBtn(Icons.Filled.FormatBold, "Bold") { applyAction(EditorActions.wrap(tfv.text, tfv.selection.start, tfv.selection.end, "**")) }
                ToolbarBtn(Icons.Filled.FormatItalic, "Italic") { applyAction(EditorActions.wrap(tfv.text, tfv.selection.start, tfv.selection.end, "*")) }
                ToolbarBtn(Icons.Filled.StrikethroughS, "Strikethrough") { applyAction(EditorActions.wrap(tfv.text, tfv.selection.start, tfv.selection.end, "~~")) }
                ToolbarBtn(Icons.Filled.Code, "Inline code") { applyAction(EditorActions.wrap(tfv.text, tfv.selection.start, tfv.selection.end, "`")) }
                ToolbarBtn(Icons.Filled.Link, "Link") {
                    linkPicker = LinkPickerRequest(
                        selectedText = tfv.text.substring(tfv.selection.min, tfv.selection.max),
                        from = tfv.selection.min, to = tfv.selection.max, wikiOnly = false,
                    )
                }
                ToolbarBtn(Icons.Filled.Superscript, "Footnote") { applyAction(EditorActions.insertFootnote(tfv.text, tfv.selection.end)) }
                ToolbarBtn(Icons.Filled.Image, "Insert image") { imagePicker.launch("image/*") }
                DictationBtn { chunk -> applyAction(EditorActions.insertDictation(tfv.text, tfv.selection.end, chunk)) }
            }
            Box(Modifier.weight(1f))
            IconButton(onClick = { save() }, enabled = activeTab?.dirty == true) {
                Icon(Icons.Filled.Save, "Save", tint = if (activeTab?.dirty == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = { showPalette = true }) { Icon(Icons.Filled.MoreVert, "Commands") }
        }

        if (conflicts.isNotEmpty()) {
            ConflictBanner(
                onKeepMine = { scope.launch { repo.resolveKeepMine(activePath, tfv.text) } },
                onTakeServer = {
                    scope.launch {
                        repo.resolveTakeServer(activePath)
                        val fresh = repo.openFile(activePath) ?: ""
                        repo.tabs.markSaved(activePath, fresh)
                        tfv = TextFieldValue(fresh)
                    }
                },
            )
        }

        // Writing-mode chrome (blog drafts / published posts).
        val isWriting = remember(activePath) { FrontmatterParser.isWritingFile(activePath) }
        val blogTags by repo.blog.tags.collectAsState()
        val blogProjects by repo.blog.projects.collectAsState()
        LaunchedEffect(isWriting) { if (isWriting) { repo.blog.refreshTags(); repo.blog.refreshProjects() } }
        if (isWriting && !viewMode) {
            WriteMetaBar(
                content = tfv.text,
                tags = blogTags,
                projects = blogProjects,
                onStamp = { updates -> applyAction(stampInBuffer(tfv, updates)) },
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                loading && activeTab == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
                viewMode -> Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
                ) {
                    NotesMarkdownView(
                        content = tfv.text,
                        repo = repo,
                        filePath = activePath,
                        onOpenNote = { p -> scope.launch { repo.tabs.open(p, repo.openFile(p) ?: "") } },
                        onOpenUrl = { openInBrowser(context, it) },
                        allPaths = files.map { it.path },
                    )
                }
                else -> androidx.compose.material3.OutlinedTextField(
                    value = tfv,
                    onValueChange = { new: TextFieldValue ->
                        // [[ opens the wiki picker.
                        if (EditorActions.justTypedWikiOpen(new.text, new.selection.end) && !EditorActions.justTypedWikiOpen(tfv.text, tfv.selection.end)) {
                            applyEdit(new)
                            linkPicker = LinkPickerRequest("", new.selection.end, new.selection.end, wikiOnly = true, triggerPos = new.selection.end - 2)
                        } else applyEdit(new)
                    },
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                )
            }
        }

        // Writing-mode action bar + status bar.
        if (isWriting) {
            WriteActionBar(
                repo = repo,
                path = activePath,
                dirty = activeTab?.dirty == true,
                onInsert = { edit -> applyAction(edit) },
                onImage = { imagePicker.launch("image/*") },
                currentContent = { tfv.text },
                selection = { tfv.selection.min to tfv.selection.max },
                onSaved = { save() },
            )
        }
        NoteStatusBar(
            path = activePath,
            dirty = activeTab?.dirty == true,
            queued = row?.dirty == true,
            vimEnabled = vimEnabled,
            onToggleVim = { vimEnabled = !vimEnabled },
            projectSlug = FrontmatterParser.enclosingProjectSlug(activePath),
            projectPill = { slug ->
                ProjectPill(repo, slug, open = projectPanelSlug == slug, onToggle = {
                    projectPanelSlug = if (projectPanelSlug == slug) null else slug
                })
            },
        )
    }

    projectPanelSlug?.let { slug ->
        ProjectPanelDialog(
            repo = repo,
            slug = slug,
            onDismiss = { projectPanelSlug = null },
            onOpenFile = { p -> scope.launch { repo.tabs.open(p, repo.openFile(p) ?: "") } },
            agents = agents,
            onOpenAgentSession = onOpenAgentSession,
        )
    }

    if (showPalette) {
        NotesCommandPalette(
            repo = repo,
            activePath = activePath,
            isDirty = activeTab?.dirty == true,
            hasClosed = tabState.recentlyClosed.any { p -> tabState.open.none { it.path == p } },
            openCount = tabState.open.size,
            onDismiss = { showPalette = false },
            onSave = { save() },
            onCloseFile = { if (!repo.tabs.close(activePath)) closeConfirm = activePath },
            onCloseAll = { repo.tabs.closeAll() },
            onReopenClosed = { scope.launch { repo.tabs.reopenLastClosed()?.let { repo.tabs.open(it, repo.openFile(it) ?: "") } } },
            onLink = { linkPicker = LinkPickerRequest(tfv.text.substring(tfv.selection.min, tfv.selection.max), tfv.selection.min, tfv.selection.max, wikiOnly = false) },
            onFootnote = { applyAction(EditorActions.insertFootnote(tfv.text, tfv.selection.end)) },
            onToast = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() },
            agents = agents,
            onOpenAgentSession = onOpenAgentSession,
        )
    }

    linkPicker?.let { req ->
        LinkPickerSheet(
            repo = repo,
            request = req,
            onDismiss = { cancelled ->
                if (cancelled && req.wikiOnly && req.triggerPos != null) {
                    // Remove the typed [[ if still present.
                    val pos = req.triggerPos
                    if (pos + 2 <= tfv.text.length && tfv.text.substring(pos, pos + 2) == "[[") {
                        val newText = tfv.text.removeRange(pos, pos + 2)
                        applyEdit(TextFieldValue(newText, TextRange(pos)))
                    }
                }
                linkPicker = null
            },
            onInsert = { edit ->
                // For a [[-triggered picker, the [[ was already typed; strip it first.
                val base = if (req.wikiOnly && req.triggerPos != null &&
                    req.triggerPos + 2 <= tfv.text.length && tfv.text.substring(req.triggerPos, req.triggerPos + 2) == "[["
                ) {
                    val cleaned = tfv.text.removeRange(req.triggerPos, req.triggerPos + 2)
                    TextFieldValue(cleaned, TextRange(req.triggerPos))
                } else tfv
                // Re-run the insert against the (possibly cleaned) buffer at the trigger.
                val insEdit = req.reinsert(base.text, base.selection.start)
                applyAction(insEdit)
                linkPicker = null
            },
        )
    }

    closeConfirm?.let { p ->
        AlertDialog(
            onDismissRequest = { closeConfirm = null },
            title = { Text("Unsaved changes") },
            text = { Text("Save changes to \"${p.substringAfterLast('/').removeSuffix(".md")}\" before closing?") },
            confirmButton = {
                TextButton(onClick = {
                    save(p)
                    repo.tabs.close(p, force = true)
                    closeConfirm = null
                    if (repo.tabs.state.value.open.isEmpty()) onBack()
                }) { Text("Save & close") }
            },
            dismissButton = {
                TextButton(onClick = {
                    repo.tabs.close(p, force = true)
                    closeConfirm = null
                    if (repo.tabs.state.value.open.isEmpty()) onBack()
                }) { Text("Discard", color = MaterialTheme.colorScheme.error) }
            },
        )
    }
}

@Composable
private fun ToolbarBtn(icon: androidx.compose.ui.graphics.vector.ImageVector, desc: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(40.dp)) {
        Icon(icon, desc, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun DictationBtn(onChunk: (String) -> Unit) {
    val context = LocalContext.current
    val state by Dictation.state.collectAsState()
    var lastLen by remember { mutableStateOf(0) }
    // Stream transcript chunks into the buffer as they arrive.
    LaunchedEffect(state.transcript, state.active) {
        if (state.active && state.transcript.length > lastLen) {
            onChunk(state.transcript.substring(lastLen))
            lastLen = state.transcript.length
        }
        if (!state.active) lastLen = 0
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) Dictation.start()
    }
    IconButton(
        onClick = {
            if (state.active) Dictation.stop { }
            else {
                val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                if (granted) Dictation.start() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        },
        modifier = Modifier.size(40.dp),
    ) {
        Icon(Icons.Filled.Mic, if (state.active) "Stop dictation" else "Dictate", modifier = Modifier.size(18.dp),
            tint = if (state.active) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun NoteTabBar(
    tabs: List<io.amar.console.data.notes.NotesTabs.Tab>,
    activePath: String,
    onSelect: (String) -> Unit,
    onClose: (String) -> Unit,
    onBack: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, modifier = Modifier.size(36.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to files", modifier = Modifier.size(18.dp))
        }
        for (tab in tabs) {
            val active = tab.path == activePath
            Row(
                Modifier
                    .padding(horizontal = 2.dp)
                    .background(
                        if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
                        RoundedCornerShape(6.dp),
                    )
                    .clickable { onSelect(tab.path) }
                    .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (tab.dirty) {
                    Icon(Icons.Filled.Circle, "unsaved", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(6.dp))
                    Box(Modifier.size(4.dp))
                }
                Text(
                    tab.path.substringAfterLast('/').removeSuffix(".md"),
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 120.dp),
                )
                IconButton(onClick = { onClose(tab.path) }, modifier = Modifier.size(24.dp)) {
                    Icon(Icons.Filled.Close, "Close tab", modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

@Composable
private fun NoteStatusBar(
    path: String,
    dirty: Boolean,
    queued: Boolean,
    vimEnabled: Boolean,
    onToggleVim: () -> Unit,
    projectSlug: String?,
    projectPill: @Composable (String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            path,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (projectSlug != null) projectPill(projectSlug)
        if (dirty) Text("modified", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        if (queued) Text("queued", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            if (vimEnabled) "vim" else "vim off",
            style = MaterialTheme.typography.labelSmall,
            color = if (vimEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clickable { onToggleVim() },
        )
    }
}

@Composable
private fun ConflictBanner(onKeepMine: () -> Unit, onTakeServer: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(horizontal = 12.dp, vertical = 8.dp),
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

/** Stamp frontmatter keys through the buffer, preserving the caret. */
internal fun stampInBuffer(tfv: TextFieldValue, updates: List<Pair<String, Any>>): EditorActions.Edit {
    val newText = FrontmatterParser.stamp(tfv.text, updates)
    // Keep caret where it was, clamped.
    val caret = minOf(tfv.selection.end + (newText.length - tfv.text.length).coerceAtLeast(0), newText.length)
    return EditorActions.Edit(newText, caret.coerceIn(0, newText.length), caret.coerceIn(0, newText.length))
}

private fun openInBrowser(context: android.content.Context, url: String) {
    runCatching {
        context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url)))
    }
}
