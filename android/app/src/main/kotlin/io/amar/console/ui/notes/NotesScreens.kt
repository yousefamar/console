package io.amar.console.ui.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.outlined.Description
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.NotesRepository
import kotlinx.coroutines.launch

/**
 * Notes: directory browser over the cached vault listing + plain-text editor
 * with queued conditional saves. (Markdown preview / vim / pen SVG come in
 * M6 — this milestone is the offline read/edit core.)
 */
@Composable
fun NotesBrowserScreen(repo: NotesRepository, onOpenFile: (String) -> Unit) {
    val files by repo.observeFiles().collectAsState(initial = emptyList())
    var currentDir by remember { mutableStateOf("") }

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
            )
        }
        if (files.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No cached listing yet — connect once", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return
        }
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
                        .clickable { onOpenFile(file.path) }
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

@Composable
fun NoteEditorScreen(repo: NotesRepository, path: String, onBack: () -> Unit) {
    val row by repo.observeFile(path).collectAsState(initial = null)
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf<String?>(null) }
    var edited by remember { mutableStateOf(false) }

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
            IconButton(
                onClick = {
                    val t = text ?: return@IconButton
                    scope.launch { repo.save(path, t) }
                    edited = false
                },
                enabled = edited,
            ) { Icon(Icons.Filled.Save, "Save", tint = if (edited) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        when (val t = text) {
            null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (row == null) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                else Text("Not cached — connect once to fetch", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> OutlinedTextField(
                value = t,
                onValueChange = { text = it; edited = true },
                modifier = Modifier.fillMaxSize().padding(8.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            )
        }
    }
}
