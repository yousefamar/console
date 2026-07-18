package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.NotificationImportant
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.db.AgentMessageRow
import io.amar.console.data.db.AgentSessionRow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val jsonLenient = Json { ignoreUnknownKeys = true }

@Composable
fun AgentSessionListScreen(repo: AgentsRepository, onOpenSession: (String) -> Unit) {
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    val approvals by repo.approvals.collectAsState()

    val sorted = remember(sessions) {
        sessions.sortedWith(
            compareByDescending<AgentSessionRow> { it.needsAttention }
                .thenByDescending { it.hasUnread }
                .thenBy { it.name.lowercase() }
        )
    }

    val connected by repo.connectedFlow.collectAsState()
    val activityMap by repo.activity.collectAsState()
    var menuTarget by remember { mutableStateOf<AgentSessionRow?>(null) }
    var creating by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        io.amar.console.ui.components.PaneTopBar(
            title = "Agents",
            subtitle = if (connected) "${sorted.size} sessions · live" else "${sorted.size} cached · offline",
        )
        if (approvals.isNotEmpty()) {
            ApprovalCard(repo, approvals.first())
        }
        if (sorted.isEmpty()) {
            io.amar.console.ui.components.EmptyState(
                Icons.Filled.Circle, "No sessions yet", "Connect once to sync the fleet",
            )
            return
        }
        Box(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                items(sorted, key = { it.id }) { session ->
                    SessionRow(
                        session,
                        isWorking = activityMap[session.id]?.running == true,
                        onClick = { onOpenSession(session.id) },
                        onLongPress = { menuTarget = session },
                    )
                }
            }
            androidx.compose.material3.FloatingActionButton(
                onClick = { creating = true },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Text("+") }
        }
    }

    menuTarget?.let { target ->
        SessionActionsSheet(
            session = target,
            onDismiss = { menuTarget = null },
            onRename = { newName -> repo.renameSession(target.id, newName) },
            onKill = { repo.killSession(target.id) },
            onMarkUnread = { repo.markUnread(target.id) },
            onMarkRead = { repo.markRead(target.id) },
        )
    }
    if (creating) {
        NewSessionDialog(
            onDismiss = { creating = false },
            onCreate = { prompt, cwd ->
                creating = false
                repo.createSession(prompt, cwd)
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionActionsSheet(
    session: AgentSessionRow,
    onDismiss: () -> Unit,
    onRename: (String) -> Unit,
    onKill: () -> Unit,
    onMarkUnread: () -> Unit,
    onMarkRead: () -> Unit,
) {
    var renaming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf(session.name) }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(session.name, style = MaterialTheme.typography.titleMedium)
            if (renaming) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Button(onClick = { onRename(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Save") }
            } else {
                androidx.compose.material3.TextButton(onClick = { renaming = true }) { Text("✎ Rename") }
                androidx.compose.material3.TextButton(onClick = { onMarkRead(); onDismiss() }) { Text("✓✓ Mark read") }
                androidx.compose.material3.TextButton(onClick = { onMarkUnread(); onDismiss() }) { Text("● Mark unread") }
                androidx.compose.material3.TextButton(onClick = { onKill(); onDismiss() }) {
                    Text("■ End session", color = MaterialTheme.colorScheme.error)
                }
            }
            androidx.compose.foundation.layout.Spacer(Modifier.size(28.dp))
        }
    }
}

@Composable
private fun NewSessionDialog(onDismiss: () -> Unit, onCreate: (prompt: String, cwd: String) -> Unit) {
    var prompt by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("/home/amar/proj/code/console") }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New session") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = cwd, onValueChange = { cwd = it },
                    label = { Text("Working directory") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = prompt, onValueChange = { prompt = it },
                    label = { Text("Prompt") }, minLines = 3, maxLines = 8,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                enabled = prompt.isNotBlank() && cwd.isNotBlank(),
                onClick = { onCreate(prompt.trim(), cwd.trim()) },
            ) { Text("Start") }
        },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(session: AgentSessionRow, isWorking: Boolean = false, onClick: () -> Unit, onLongPress: () -> Unit = {}) {
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongPress)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (isWorking) {
            androidx.compose.material3.CircularProgressIndicator(
                modifier = Modifier.size(12.dp),
                strokeWidth = 1.5.dp,
            )
        } else {
            Icon(
                if (session.hibernated) Icons.Filled.Bedtime else Icons.Filled.Circle,
                contentDescription = session.status,
                tint = when {
                    session.status == "running" -> MaterialTheme.colorScheme.primary
                    session.hibernated -> MaterialTheme.colorScheme.onSurfaceVariant
                    else -> MaterialTheme.colorScheme.surfaceVariant
                },
                modifier = Modifier.size(10.dp),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                session.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (session.hasUnread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            session.attentionSnippet?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (session.needsAttention) {
            Icon(
                Icons.Filled.NotificationImportant,
                contentDescription = "Needs attention",
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(16.dp),
            )
        }
        if (session.hasUnread) {
            Box(
                Modifier.size(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

@Composable
fun AgentSessionScreen(repo: AgentsRepository, sessionId: String, onBack: () -> Unit = {}, onComposerChange: (String) -> Unit = {}) {
    val messages by repo.observeMessages(sessionId).collectAsState(initial = emptyList())
    val approvals by repo.approvals.collectAsState()
    val sessionApprovals = remember(approvals) { approvals.filter { it.sessionId == sessionId } }
    val scope = rememberCoroutineScope()
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    val session = remember(sessions) { sessions.firstOrNull { it.id == sessionId } }
    val connected by repo.connectedFlow.collectAsState()

    // Desktop parity: opening a session does NOT clear its unread/attention
    // marker — only the explicit ✓✓ action (or sending a prompt) does.

    Column(Modifier.fillMaxSize().imePadding()) {
        val activityMap by repo.activity.collectAsState()
        val act = activityMap[sessionId]
        io.amar.console.ui.components.PaneTopBar(
            title = session?.name ?: "…",
            subtitle = listOfNotNull(
                if (act?.running == true) "working…" else session?.status,
                act?.currentTool?.let { "⚙ $it" },
                session?.modelLabel,
                if (!connected) "offline — sends queue" else null,
            ).joinToString(" · ").ifEmpty { null },
            onBack = onBack,
            actions = {
                if (act?.running == true) {
                    IconButton(onClick = { repo.interrupt(sessionId) }) {
                        Icon(
                            Icons.Filled.StopCircle,
                            contentDescription = "Interrupt",
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
                if (session?.hasUnread == true || session?.needsAttention == true) {
                    IconButton(onClick = { repo.markRead(sessionId) }) {
                        Icon(
                            Icons.Filled.DoneAll,
                            contentDescription = "Mark read",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            },
        )
        val usage = (repo.contextUsage.collectAsState().value)[sessionId]
        if (usage != null && usage.maxTokens > 0) {
            val frac = (usage.totalTokens.toFloat() / usage.maxTokens).coerceIn(0f, 1f)
            androidx.compose.material3.LinearProgressIndicator(
                progress = { frac },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                color = when {
                    frac > 0.9f -> MaterialTheme.colorScheme.error
                    frac > 0.7f -> MaterialTheme.colorScheme.tertiary
                    else -> MaterialTheme.colorScheme.primary
                },
            )
        }
        if (sessionApprovals.isNotEmpty()) {
            ApprovalCard(repo, sessionApprovals.first())
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            reverseLayout = true,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp),
        ) {
            items(messages, key = { it.pk }) { msg ->
                TranscriptBlock(msg)
            }
        }
        if (act?.running == true || act?.statusText != null) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.material3.CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                )
                Text(
                    act?.statusText ?: act?.currentTool?.let { "running $it" } ?: "thinking…",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val ctx = androidx.compose.ui.platform.LocalContext.current
        io.amar.console.ui.components.Composer(
            placeholder = "Prompt — queues offline",
            draftKey = "agent:$sessionId",
            onSend = { text -> scope.launch { repo.sendPrompt(sessionId, text) }; repo.markRead(sessionId) },
            onTextChange = onComposerChange,
            onSendWithAttachments = { text, uris ->
                scope.launch { repo.sendPrompt(sessionId, text, uris, ctx) }
                repo.markRead(sessionId)
            },
        )
    }
}
