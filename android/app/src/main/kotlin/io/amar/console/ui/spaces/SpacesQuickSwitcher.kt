package io.amar.console.ui.spaces

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.NoteFileRow
import io.amar.console.data.spaces.SpacesRepository
import io.amar.console.data.spaces.SpacesSwitcher

private val VIOLET = androidx.compose.ui.graphics.Color(0xFFA78BFA)
private val AMBER = androidx.compose.ui.graphics.Color(0xFFF59E0B)

/**
 * Spaces quick switcher — the SPA's `/` command bar (SpacesQuickSwitcher.tsx)
 * as a dialog: one field, fuzzy over spaces + live sessions + vault files,
 * recency-sorted when empty. Pure ranking lives in [SpacesSwitcher].
 */
@Composable
fun SpacesQuickSwitcher(
    spaces: List<SpacesRepository.SpaceSummary>,
    sessions: List<AgentSessionRow>,
    files: List<NoteFileRow>,
    running: Set<String>,
    onDismiss: () -> Unit,
    onPick: (SpacesSwitcher.Entry) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val entries = remember(spaces, sessions, files, running) { SpacesSwitcher.build(spaces, sessions, files, running) }
    val results = remember(entries, query) { SpacesSwitcher.rank(entries, query) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = null,
        text = {
            Column {
                OutlinedTextField(
                    value = query, onValueChange = { query = it },
                    placeholder = { Text("Jump to space, agent, file…") },
                    leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.fillMaxWidth().height(360.dp)) {
                    if (results.isEmpty()) {
                        item {
                            Text(
                                "Nothing matches", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                        }
                    }
                    items(results, key = { it.key }) { e -> SwitcherRow(e) { onPick(e) } }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun SwitcherRow(e: SpacesSwitcher.Entry, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 9.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val tint = MaterialTheme.colorScheme.onSurfaceVariant
        when {
            e.kind == SpacesSwitcher.Kind.AREA -> Icon(Icons.Filled.Tag, null, Modifier.size(14.dp), tint = tint)
            e.kind == SpacesSwitcher.Kind.PROJECT -> Icon(Icons.Filled.ViewKanban, null, Modifier.size(14.dp), tint = tint)
            e.kind == SpacesSwitcher.Kind.FILE -> Icon(Icons.AutoMirrored.Filled.InsertDriveFile, null, Modifier.size(14.dp), tint = tint)
            e.isFork -> Icon(Icons.AutoMirrored.Filled.CallSplit, "Fork", Modifier.size(14.dp), tint = VIOLET.copy(alpha = 0.7f))
            else -> Icon(Icons.Filled.SmartToy, null, Modifier.size(14.dp), tint = tint)
        }
        // Title takes the slack; the hint is width-bounded so it can never be
        // starved to a one-char-per-line column (the Row trap).
        Text(
            e.title, style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        e.hint?.let {
            Text(
                it, style = MaterialTheme.typography.labelSmall, color = tint,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp),
            )
        }
        if (e.running) Dot(AMBER)
    }
}
