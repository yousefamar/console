package io.amar.console.ui.agents

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.NotificationImportant
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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

    Column(Modifier.fillMaxSize()) {
        if (approvals.isNotEmpty()) {
            ApprovalBanner(repo, approvals.first())
        }
        if (sorted.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No cached sessions — connect once", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(sorted, key = { it.id }) { session ->
                SessionRow(session, onClick = { onOpenSession(session.id) })
            }
        }
    }
}

@Composable
private fun ApprovalBanner(repo: AgentsRepository, approval: AgentsRepository.Approval) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            "Approval: ${approval.toolName}",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            approval.inputPreview,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { repo.approve(approval.sessionId, approval.requestId) }) { Text("Approve") }
            OutlinedButton(onClick = { repo.deny(approval.sessionId, approval.requestId) }) { Text("Deny") }
        }
    }
}

@Composable
private fun SessionRow(session: AgentSessionRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
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
fun AgentSessionScreen(repo: AgentsRepository, sessionId: String) {
    val messages by repo.observeMessages(sessionId).collectAsState(initial = emptyList())
    val approvals by repo.approvals.collectAsState()
    val sessionApprovals = remember(approvals) { approvals.filter { it.sessionId == sessionId } }
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf("") }

    LaunchedEffect(sessionId) { repo.markRead(sessionId) }

    Column(Modifier.fillMaxSize().imePadding()) {
        if (sessionApprovals.isNotEmpty()) {
            ApprovalBanner(repo, sessionApprovals.first())
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            reverseLayout = true,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp),
        ) {
            items(messages, key = { it.pk }) { msg ->
                AgentMessageBlock(msg)
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Prompt — queues offline") },
                maxLines = 5,
            )
            IconButton(onClick = {
                val text = draft.trim()
                if (text.isNotEmpty()) {
                    draft = ""
                    scope.launch { repo.sendPrompt(sessionId, text) }
                }
            }) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@Composable
private fun AgentMessageBlock(msg: AgentMessageRow) {
    val payload = remember(msg.pk) {
        runCatching { jsonLenient.parseToJsonElement(msg.payloadJson).jsonObject }.getOrNull()
    }
    val content = payload?.get("content")?.jsonPrimitive?.content
        ?: payload?.get("text")?.jsonPrimitive?.content
        ?: ""
    when (msg.kind) {
        "user_prompt" -> Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            Text(
                content,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
        "text" -> Text(
            content,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp),
        )
        "tool_use" -> {
            val tool = payload?.get("toolName")?.jsonPrimitive?.content ?: "tool"
            Text(
                "⚙ $tool",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
            )
        }
        "result" -> Text(
            "— turn complete —",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
        )
        else -> { /* thinking / tool_result / diffs: skipped in the v1 mobile transcript */ }
    }
}
