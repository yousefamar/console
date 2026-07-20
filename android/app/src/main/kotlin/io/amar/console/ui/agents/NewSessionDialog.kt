package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import kotlinx.coroutines.delay
import java.util.Date
import java.text.DateFormat

/**
 * New-session dialog with a working-dir field (project-dir + hub filesystem
 * autocomplete) and a "Resume a past session" picker that appears once a dir is
 * chosen. Ported from AgentPromptInput.tsx's dir picker + resume flow.
 */
@Composable
fun NewSessionDialog(
    repo: AgentsRepository,
    onDismiss: () -> Unit,
    onCreate: (prompt: String, cwd: String) -> Unit,
    onResume: (claudeSessionId: String, prompt: String, cwd: String) -> Unit,
) {
    var prompt by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("/home/amar/proj/code/console") }
    var resumeId by remember { mutableStateOf<String?>(null) }
    val projectDirs by repo.projectDirs.collectAsState()
    val pastSessions by repo.pastSessions.collectAsState()

    // List past sessions for the chosen cwd (debounced).
    LaunchedEffect(cwd) {
        delay(300)
        if (cwd.isNotBlank()) repo.listPastSessions(cwd.trim())
    }

    val dirSuggestions = remember(cwd, projectDirs) {
        if (cwd.isBlank()) emptyList()
        else projectDirs.filter { it.contains(cwd, ignoreCase = true) && it != cwd }.take(6)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New session") },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = cwd, onValueChange = { cwd = it; resumeId = null },
                    label = { Text("Working directory") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("~ (home directory)") },
                )
                for (dir in dirSuggestions) {
                    Text(
                        dir, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace,
                        modifier = Modifier.fillMaxWidth().clickable { cwd = dir }.padding(vertical = 3.dp),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                // Resume-a-past-session picker.
                if (pastSessions.isNotEmpty()) {
                    Text("Resume a past session", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val fmt = DateFormat.getDateInstance(DateFormat.MEDIUM)
                    for (ps in pastSessions.take(5)) {
                        val selected = resumeId == ps.sessionId
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp))
                                .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
                                .clickable { resumeId = if (selected) null else ps.sessionId }.padding(6.dp),
                        ) {
                            Text(ps.prompt.take(80), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            val ageMs = System.currentTimeMillis() - ps.date
                            Text(
                                if (ageMs < 7 * 86_400_000L) TranscriptHelpers.relativeDate(ageMs) else fmt.format(Date(ps.date)),
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = prompt, onValueChange = { prompt = it },
                    label = { Text(if (resumeId != null) "Send a message to resume…" else "Prompt") },
                    minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                enabled = prompt.isNotBlank() && cwd.isNotBlank(),
                onClick = {
                    val rid = resumeId
                    if (rid != null) onResume(rid, prompt.trim(), cwd.trim())
                    else onCreate(prompt.trim(), cwd.trim())
                },
            ) { Text(if (resumeId != null) "Resume" else "Start") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
