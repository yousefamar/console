package io.amar.console.ui.notes

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Publish
import androidx.compose.material.icons.filled.Superscript
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.core.Dictation
import io.amar.console.data.notes.BlogRepository
import io.amar.console.data.notes.EditorActions
import io.amar.console.data.notes.FrontmatterParser
import io.amar.console.data.notes.NotesRepository
import kotlinx.coroutines.launch

/**
 * Collapsible write meta bar: structured title / tags / project editing that
 * round-trips through the buffer via frontmatter stamping. Collapse state
 * persisted in SharedPreferences. (src/components/notes/WriteMetaBar.tsx)
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun WriteMetaBar(
    content: String,
    tags: List<String>,
    projects: List<BlogRepository.Project>,
    onStamp: (List<Pair<String, Any>>) -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("notes_write", android.content.Context.MODE_PRIVATE) }
    var collapsed by remember { mutableStateOf(prefs.getBoolean("metaBarCollapsed", false)) }

    val fm = remember(content) { FrontmatterParser.parse(content) }
    var titleField by remember(fm.title) { mutableStateOf(fm.title ?: "") }
    var tagInput by remember { mutableStateOf("") }
    var tagFocused by remember { mutableStateOf(false) }
    val currentTags = fm.tags

    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)).padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = {
                collapsed = !collapsed
                prefs.edit().putBoolean("metaBarCollapsed", collapsed).apply()
            }, modifier = Modifier.size(28.dp)) {
                Icon(if (collapsed) Icons.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown, "Toggle meta", modifier = Modifier.size(18.dp))
            }
            if (collapsed) {
                val summary = buildString {
                    append(fm.title?.ifBlank { null } ?: "(untitled)")
                    if (currentTags.isNotEmpty()) append(" · ").append(currentTags.joinToString(" · "))
                    fm.project?.let { append(" · @").append(it) }
                }
                Text(summary, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else {
                Text("Post details", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        if (!collapsed) {
            OutlinedTextField(
                value = titleField,
                onValueChange = { titleField = it },
                label = { Text("Title") }, singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences),
                modifier = Modifier.fillMaxWidth()
                    .onFocusChangedCompatMeta { focused -> if (!focused && titleField != (fm.title ?: "")) onStamp(listOf("title" to titleField)) },
            )
            // Tag chips.
            FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (tag in currentTags) {
                    Row(
                        Modifier.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(12.dp)).padding(start = 8.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(tag, style = MaterialTheme.typography.labelSmall)
                        IconButton(onClick = { onStamp(listOf("tags" to currentTags.filter { it != tag })) }, modifier = Modifier.size(18.dp)) {
                            Icon(Icons.Filled.Close, "Remove tag", modifier = Modifier.size(12.dp))
                        }
                    }
                }
            }
            OutlinedTextField(
                value = tagInput,
                onValueChange = { v ->
                    // Enter (newline) commits the tag.
                    if (v.endsWith("\n")) {
                        val t = v.trim()
                        if (t.isNotEmpty() && !currentTags.contains(t)) onStamp(listOf("tags" to (currentTags + t)))
                        tagInput = ""
                    } else tagInput = v
                },
                label = { Text("Add tag") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().onFocusChangedCompatMeta { tagFocused = it },
            )
            // Tag autocomplete (up to 8, excluding applied).
            if (tagFocused && tagInput.isNotBlank()) {
                val sugg = tags.filter { it.contains(tagInput.trim(), true) && !currentTags.contains(it) }.take(8)
                Column {
                    for (s in sugg) {
                        Text(s, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().clickable {
                            onStamp(listOf("tags" to (currentTags + s))); tagInput = ""
                        }.padding(vertical = 6.dp, horizontal = 8.dp))
                    }
                }
            }
            // Project select.
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Project:", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    ProjectChip("none", fm.project == null) { onStamp(listOf("project" to "")) }
                    for (p in projects) {
                        ProjectChip(p.slug, fm.project == p.slug) { onStamp(listOf("project" to p.slug)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .background(if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/**
 * Write action bar: insert-image, camera, dictation mic, insert-footnote,
 * format-dictation (AI), and publish/re-publish/view-live buttons.
 * (src/components/notes/WriteActionBar.tsx)
 */
@Composable
fun WriteActionBar(
    repo: NotesRepository,
    path: String,
    dirty: Boolean,
    onInsert: (EditorActions.Edit) -> Unit,
    onImage: () -> Unit,
    currentContent: () -> String,
    selection: () -> Pair<Int, Int>,
    onSaved: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val dictation by Dictation.state.collectAsState()
    var formatting by remember { mutableStateOf(false) }
    var publishing by remember { mutableStateOf(false) }
    val isDraft = FrontmatterParser.isDraftPath(path)
    val isPublished = FrontmatterParser.isPublishedPath(path)
    val liveMap by repo.blog.liveStatus.collectAsState()
    val live = liveMap[path]

    // Camera capture into a FileProvider-shared temp file. Reuse the declared
    // `mail-attachments/` cache subpath + `${applicationId}.files` authority
    // (see AndroidManifest FileProvider) so no manifest change is needed.
    val cameraFile = remember {
        java.io.File(context.cacheDir, "mail-attachments").apply { mkdirs() }.let { java.io.File(it, "notes-camera.jpg") }
    }
    val cameraUri = remember {
        androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", cameraFile)
    }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (ok) scope.launch {
            insertImageFromUri(context, repo, cameraUri, androidx.compose.ui.text.input.TextFieldValue(currentContent(), androidx.compose.ui.text.TextRange(selection().second))) { onInsert(it) }
        }
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) cameraLauncher.launch(cameraUri)
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) Dictation.start()
    }
    // Stream dictation chunks with smart spacing.
    var lastLen by remember { mutableStateOf(0) }
    LaunchedEffect(dictation.transcript, dictation.active) {
        if (dictation.active && dictation.transcript.length > lastLen) {
            val chunk = dictation.transcript.substring(lastLen)
            onInsert(EditorActions.insertDictation(currentContent(), selection().second, chunk))
            lastLen = dictation.transcript.length
        }
        if (!dictation.active) lastLen = 0
    }

    LaunchedEffect(path) {
        if (isPublished) repo.blog.checkLiveStatus(path, System.currentTimeMillis())
    }

    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(horizontal = 6.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        ActBtn(Icons.Filled.Image, "Insert image", onClick = onImage)
        ActBtn(Icons.Filled.CameraAlt, "Take photo") {
            if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) cameraLauncher.launch(cameraUri)
            else cameraPermission.launch(Manifest.permission.CAMERA)
        }
        ActBtn(Icons.Filled.Mic, if (dictation.active) "Stop" else "Dictate", tint = if (dictation.active) MaterialTheme.colorScheme.error else null) {
            if (dictation.active) Dictation.stop { }
            else {
                if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) Dictation.start()
                else micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
        ActBtn(Icons.Filled.Superscript, "Footnote") {
            onInsert(EditorActions.insertFootnote(currentContent(), selection().second))
        }
        if (formatting) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        } else {
            ActBtn(Icons.Filled.AutoAwesome, "Format dictation") {
                scope.launch {
                    formatting = true
                    try {
                        val text = currentContent()
                        val (selStart, selEnd) = selection()
                        val fmRange = FrontmatterParser.range(text)
                        val target = if (selEnd > selStart) text.substring(selStart, selEnd)
                        else if (fmRange != null) text.substring(fmRange.last + 1) else text
                        val r = repo.blog.formatDictation(target)
                        if (r.ok && r.text != null) {
                            val newText = if (selEnd > selStart) text.substring(0, selStart) + r.text + text.substring(selEnd)
                            else if (fmRange != null) text.substring(0, fmRange.last + 1) + r.text else r.text
                            onInsert(EditorActions.Edit(newText, minOf(selStart, newText.length), minOf(selStart, newText.length)))
                            android.widget.Toast.makeText(context, "Formatted", android.widget.Toast.LENGTH_SHORT).show()
                        } else android.widget.Toast.makeText(context, "Format failed", android.widget.Toast.LENGTH_SHORT).show()
                    } finally { formatting = false }
                }
            }
        }
        Box(Modifier.weight(1f))
        // Live-status chip for published posts.
        if (isPublished && live != null) LiveStatusChip(live) {
            scope.launch { repo.blog.checkLiveStatus(path, System.currentTimeMillis()) }
        }
        if (isPublished) {
            ActBtn(Icons.Filled.OpenInNew, "View live") {
                FrontmatterParser.permalinkForLogPath(path)?.let { url ->
                    runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
                }
            }
        }
        if (isDraft || isPublished) {
            if (publishing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text(
                (if (isDraft) "Publish" else "Re-publish") + if (dirty) "*" else "",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.clickable {
                    scope.launch {
                        publishing = true
                        try {
                            if (dirty) onSaved()
                            android.widget.Toast.makeText(context, if (isDraft) "Publishing…" else "Re-publish queued…", android.widget.Toast.LENGTH_SHORT).show()
                            val r = if (isDraft) repo.blog.publish(path) else repo.blog.republish(path)
                            if (r.ok) {
                                val postPath = r.newPath ?: path
                                repo.blog.setLiveStatus(postPath, BlogRepository.LiveStatus.BUILDING)
                                if (isDraft) {
                                    repo.tabs.close(path, force = true)
                                    repo.reconcile()
                                    r.newPath?.let { repo.tabs.open(it, repo.openFile(it) ?: "") }
                                    repo.blog.refreshDrafts(); repo.blog.refreshRecentPosts()
                                }
                                // Background-verify via ETag polling (~3 min).
                                val url = FrontmatterParser.permalinkForLogPath(postPath)
                                if (url != null) {
                                    val baseline = repo.blog.fetchPageEtag(url)
                                    val live = waitForSiteUpdate(repo, url, baseline)
                                    repo.blog.setLiveStatus(postPath, if (live) BlogRepository.LiveStatus.LIVE else BlogRepository.LiveStatus.STALE)
                                    android.widget.Toast.makeText(context, if (live) (if (isDraft) "Post is live" else "Edit is live") else "Build still not live after 3min", android.widget.Toast.LENGTH_LONG).show()
                                }
                            } else android.widget.Toast.makeText(context, "Publish failed: ${r.error ?: "unknown"}", android.widget.Toast.LENGTH_LONG).show()
                        } finally { publishing = false }
                    }
                }.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/** Poll the permalink ETag every 5s up to ~3 min; true when it moves. */
private suspend fun waitForSiteUpdate(repo: NotesRepository, url: String, baseline: String?): Boolean {
    repeat(36) {
        kotlinx.coroutines.delay(5000)
        val etag = repo.blog.fetchPageEtag(url)
        if (etag != null && etag != baseline) return true
    }
    return false
}

@Composable
private fun LiveStatusChip(status: BlogRepository.LiveStatus, onClick: () -> Unit) {
    val (label, color) = when (status) {
        BlogRepository.LiveStatus.LIVE -> "live" to androidx.compose.ui.graphics.Color(0xFF4ADE80)
        BlogRepository.LiveStatus.STALE -> "stale" to androidx.compose.ui.graphics.Color(0xFFF5C542)
        BlogRepository.LiveStatus.BUILDING -> "building" to androidx.compose.ui.graphics.Color(0xFF60A5FA)
        BlogRepository.LiveStatus.UNKNOWN -> "?" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        Modifier.clickable(onClick = onClick).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(Modifier.size(6.dp).background(color, RoundedCornerShape(3.dp)))
        Text(label, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

@Composable
private fun ActBtn(icon: androidx.compose.ui.graphics.vector.ImageVector, desc: String, tint: androidx.compose.ui.graphics.Color? = null, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(38.dp)) {
        Icon(icon, desc, modifier = Modifier.size(18.dp), tint = tint ?: MaterialTheme.colorScheme.onSurface)
    }
}

/** onFocusChanged bool helper local to this file. */
private fun Modifier.onFocusChangedCompatMeta(onChange: (Boolean) -> Unit): Modifier =
    this.onFocusChanged { onChange(it.isFocused) }
