package io.amar.console.ui.notes

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.amar.console.data.notes.BlogHelpers
import io.amar.console.data.notes.FrontmatterParser
import io.amar.console.data.notes.Fuzzy
import io.amar.console.data.notes.NotesRepository
import kotlinx.coroutines.launch

/**
 * Notes command palette as a mobile-friendly dialog: a fuzzy-filterable command
 * list (Ctrl+Shift+P on desktop). Active-file commands only shown when a file
 * is open; blog/publish commands gated on draft paths. (src/components/
 * NotesCommandPalette.tsx)
 */
@Composable
fun NotesCommandPalette(
    repo: NotesRepository,
    activePath: String?,
    isDirty: Boolean,
    hasClosed: Boolean,
    openCount: Int,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    onCloseFile: () -> Unit,
    onCloseAll: () -> Unit,
    onReopenClosed: () -> Unit,
    onLink: () -> Unit,
    onFootnote: () -> Unit,
    onToast: (String) -> Unit,
    /** Agent cross-pane wiring (FEATURES notes #9/#10) — when null those
     *  commands are omitted. */
    agents: io.amar.console.data.agents.AgentsRepository? = null,
    onOpenAgentSession: (String) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var newDraftPrompt by remember { mutableStateOf(false) }
    var newProjectPrompt by remember { mutableStateOf(false) }
    var startAgentPrompt by remember { mutableStateOf(false) }

    // Project slug of the active file (for the agent cwd).
    val projectSlug = activePath?.let { FrontmatterParser.enclosingProjectSlug(it) }
    // Live sessions under the active project (for "Jump to agent").
    val liveSessions by (if (agents != null && projectSlug != null)
        agents.observeSessionsUnderCwd("/projects/$projectSlug")
    else kotlinx.coroutines.flow.flowOf(emptyList()))
        .collectAsState(initial = emptyList())

    data class Cmd(val label: String, val run: () -> Unit)
    val commands = buildList {
        if (activePath != null) {
            add(Cmd("Save File", onSave))
            add(Cmd("Close File", onCloseFile))
            add(Cmd("Insert Link", onLink))
            add(Cmd("Insert Footnote", onFootnote))
            if (agents != null && projectSlug != null) {
                add(Cmd("Start Agent in ${BlogHelpers.humaniseSlug(projectSlug)}") { startAgentPrompt = true })
                for (s in liveSessions) {
                    add(Cmd("Jump to agent · ${s.name.ifBlank { s.id }.removeSuffix(" (fork)")}") {
                        onDismiss(); onOpenAgentSession(s.id)
                    })
                }
            }
            if (FrontmatterParser.isDraftPath(activePath)) {
                add(Cmd("Publish Draft") {
                    scope.launch {
                        onToast("Publishing…")
                        val r = repo.blog.publish(activePath)
                        if (r.ok) {
                            repo.tabs.close(activePath, force = true)
                            repo.reconcile()
                            repo.blog.refreshDrafts(); repo.blog.refreshRecentPosts(); repo.blog.refreshProjects()
                            val url = r.newPath?.let { FrontmatterParser.permalinkForLogPath(it) }
                            onToast(if (url != null) "Published → $url" else "Published")
                        } else onToast("Publish failed: ${r.error ?: "unknown"}")
                    }
                })
            }
        }
        add(Cmd("New Blog Draft") { newDraftPrompt = true })
        add(Cmd("New Project") { newProjectPrompt = true })
        if (hasClosed) add(Cmd("Reopen Closed Tab", onReopenClosed))
        if (openCount > 1) add(Cmd("Close All Files", onCloseAll))
    }
    val filtered = Fuzzy.filter(commands, query) { it.label }

    if (newDraftPrompt) {
        TitlePromptDialog(
            title = "New blog draft",
            inheritProject = FrontmatterParser.enclosingProjectSlug(activePath),
            onDismiss = { newDraftPrompt = false },
            onConfirm = { t ->
                newDraftPrompt = false; onDismiss()
                scope.launch {
                    val r = repo.blog.createDraft(t, FrontmatterParser.enclosingProjectSlug(activePath))
                    if (r.ok && r.path != null) {
                        repo.reconcile(); repo.tabs.open(r.path, repo.openFile(r.path) ?: ""); repo.blog.refreshDrafts()
                    } else onToast(r.error ?: "Draft failed")
                }
            },
        )
        return
    }
    if (newProjectPrompt) {
        TitlePromptDialog(
            title = "New project",
            inheritProject = null,
            onDismiss = { newProjectPrompt = false },
            onConfirm = { t ->
                newProjectPrompt = false; onDismiss()
                scope.launch {
                    val r = repo.blog.createProject(t)
                    if (r.ok && r.path != null) {
                        repo.reconcile(); repo.tabs.open(r.path, repo.openFile(r.path) ?: ""); repo.blog.refreshProjects()
                    } else onToast(r.error ?: "Project failed")
                }
            },
        )
        return
    }
    if (startAgentPrompt && agents != null && projectSlug != null) {
        TitlePromptDialog(
            title = "Start agent in ${BlogHelpers.humaniseSlug(projectSlug)}",
            inheritProject = null,
            confirmLabel = "Start",
            fieldLabel = "First message",
            onDismiss = { startAgentPrompt = false },
            onConfirm = { firstMessage ->
                startAgentPrompt = false; onDismiss()
                scope.launch {
                    val vault = repo.getVaultPath()
                    if (vault != null) {
                        agents.createSession(firstMessage, "$vault/projects/$projectSlug", BlogHelpers.humaniseSlug(projectSlug))
                        onToast("Starting agent…")
                    } else onToast("Vault path not loaded — try again")
                }
            },
        )
        return
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Commands") },
        text = {
            Column {
                OutlinedTextField(
                    value = query, onValueChange = { query = it },
                    label = { Text("Filter…") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                LazyColumn(Modifier.fillMaxWidth().height(320.dp)) {
                    if (filtered.isEmpty()) {
                        item { Text("No commands found", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp)) }
                    }
                    items(filtered, key = { it.label }) { cmd ->
                        Text(
                            cmd.label,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.fillMaxWidth().clickable {
                                onDismiss(); cmd.run()
                            }.padding(vertical = 10.dp, horizontal = 4.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
internal fun TitlePromptDialog(
    title: String,
    inheritProject: String?,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    confirmLabel: String = "Create",
    fieldLabel: String = "Title",
) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title + (inheritProject?.let { " · project: $it" } ?: "")) },
        text = {
            OutlinedTextField(
                value = text, onValueChange = { text = it },
                label = { Text(fieldLabel) }, singleLine = fieldLabel == "Title",
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(enabled = text.isNotBlank(), onClick = { onConfirm(text.trim()) }) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
