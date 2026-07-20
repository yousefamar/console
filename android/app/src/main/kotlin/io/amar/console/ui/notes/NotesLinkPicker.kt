package io.amar.console.ui.notes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.EditorActions
import io.amar.console.data.notes.Fuzzy
import io.amar.console.data.notes.NotesRepository

/**
 * Describes a pending link insertion over the editor selection. [reinsert]
 * reruns the chosen insert against a (possibly `[[`-stripped) buffer so the
 * caller can apply it at the trigger position. Mirrors the SPA's openLinkPicker
 * payload (mode 'wiki' | 'both').
 */
class LinkPickerRequest(
    val selectedText: String,
    val from: Int,
    val to: Int,
    /** Wiki-only ([[-triggered); false = both tabs (Ctrl+Shift+K / :link). */
    val wikiOnly: Boolean,
    /** Position of the literal `[[` typed to trigger a wiki picker, if any. */
    val triggerPos: Int? = null,
) {
    /** Chosen insert, set by the sheet, applied by the editor after cleanup. */
    var chosen: ((text: String, at: Int) -> EditorActions.Edit)? = null
    fun reinsert(text: String, at: Int): EditorActions.Edit =
        chosen?.invoke(text, at) ?: EditorActions.Edit(text, at, at)
}

/**
 * Link picker: Wiki-Link / URL mode tabs (both mode only). Wiki mode lists the
 * 30 most-recently-modified files on an empty query, else fuzzy filenames;
 * selecting inserts `[[Target|alias]]`. URL mode has URL + display inputs.
 * (src/components/NotesLinkPicker.tsx)
 */
@Composable
fun LinkPickerSheet(
    repo: NotesRepository,
    request: LinkPickerRequest,
    onDismiss: (cancelled: Boolean) -> Unit,
    onInsert: (EditorActions.Edit) -> Unit,
) {
    val files by repo.observeFiles().collectAsState(initial = emptyList())
    var tab by remember { mutableStateOf(0) } // 0 = wiki, 1 = url
    var query by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var display by remember { mutableStateOf(request.selectedText) }

    val wikiResults = remember(files, query) {
        if (query.isBlank()) files.sortedByDescending { it.mtime }.take(30)
        else Fuzzy.filter(files.sortedByDescending { it.mtime }, query) { it.path }.take(30)
    }

    AlertDialog(
        onDismissRequest = { onDismiss(true) },
        title = { Text(if (request.wikiOnly) "Wiki link" else "Insert link") },
        text = {
            Column {
                if (!request.wikiOnly) {
                    TabRow(selectedTabIndex = tab) {
                        Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Wiki") })
                        Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("URL") })
                    }
                }
                if (request.wikiOnly || tab == 0) {
                    OutlinedTextField(
                        value = query, onValueChange = { query = it },
                        label = { Text("Search notes") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                    )
                    LazyColumn(Modifier.fillMaxWidth().height(280.dp)) {
                        if (wikiResults.isEmpty()) {
                            item { Text("No files found", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp)) }
                        }
                        items(wikiResults, key = { it.path }) { f ->
                            Column(
                                Modifier.fillMaxWidth().clickable {
                                    request.chosen = { text, at ->
                                        if (request.selectedText.isNotEmpty())
                                            EditorActions.insertWikiLink(text, request.from, request.to, f.path)
                                        else EditorActions.insertWikiLink(text, at, at, f.path)
                                    }
                                    onInsert(EditorActions.Edit("", 0, 0))
                                }.padding(vertical = 6.dp, horizontal = 4.dp),
                            ) {
                                Text(f.name.removeSuffix(".md"), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(f.dir.ifEmpty { "/" }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 6.dp)) {
                        OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("https://...") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(value = display, onValueChange = { display = it }, label = { Text("Display text (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton(
                                enabled = url.isNotBlank(),
                                onClick = {
                                    request.chosen = { text, at ->
                                        if (request.selectedText.isNotEmpty())
                                            EditorActions.insertUrlLink(text, request.from, request.to, url.trim(), display)
                                        else EditorActions.insertUrlLink(text, at, at, url.trim(), display)
                                    }
                                    onInsert(EditorActions.Edit("", 0, 0))
                                },
                            ) { Text("Insert") }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = { onDismiss(true) }) { Text("Cancel") } },
    )
}
