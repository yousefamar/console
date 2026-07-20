package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.agents.Cron
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

private val AMBER = Color(0xFFF59E0B)
private val VIOLET = Color(0xFFA78BFA)
private val GREEN = Color(0xFF4ADE80)
private val RED = Color(0xFFF87171)

// ------------------------------------------------------------------ //
// Cron sheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CronSheet(claudeSessionId: String, onDismiss: () -> Unit) {
    val tasks by Cron.tasksFor(claudeSessionId).collectAsState(initial = emptyList())
    val icsUrl by Cron.icsUrl.collectAsState()
    val icsPublic by Cron.icsPublic.collectAsState()
    var showForm by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(claudeSessionId) { Cron.refresh(claudeSessionId); Cron.fetchIcsToken() }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Scheduled prompts", style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = { showForm = !showForm }) { Text(if (showForm) "Hide form" else "+ New") }
            }
            if (tasks.isEmpty() && !showForm) {
                Text("No scheduled prompts for this session.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            for (task in tasks) CronTaskRow(task, onRun = { scope.launch { Cron.runOnce(task.id) } }, onDelete = { Cron.remove(task.id, claudeSessionId) })
            if (showForm) CronCreateForm(claudeSessionId) { showForm = false }
            // ICS subscription URL.
            icsUrl?.let { url ->
                val clip = LocalClipboardManager.current
                var copied by remember { mutableStateOf(false) }
                Row(
                    Modifier.fillMaxWidth().padding(top = 8.dp).clickable { clip.setText(AnnotatedString(url)); copied = true },
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        if (copied) "copied" else "Calendar URL (${if (icsPublic) "public" else "tailnet"})",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            Box(Modifier.size(20.dp))
        }
    }
}

@Composable
private fun CronTaskRow(task: Cron.Task, onRun: () -> Unit, onDelete: () -> Unit) {
    val nextIn = remember(task.trigger, task.disabledAt) {
        if (task.disabledAt != null) null
        else runCatching { CronExpr.nextRuns(task.trigger, System.currentTimeMillis(), 1).firstOrNull() }.getOrNull()
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)).padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(if (task.recurring) Icons.Filled.Repeat else Icons.Filled.CalendarMonth, contentDescription = null, modifier = Modifier.size(11.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(task.trigger, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (task.disabledAt != null) Text("disabled", style = MaterialTheme.typography.labelSmall, color = RED)
            Icon(Icons.Filled.PlayArrow, contentDescription = "Run now", modifier = Modifier.size(18.dp).clickable { onRun() }, tint = MaterialTheme.colorScheme.primary)
            Icon(Icons.Filled.Delete, contentDescription = "Delete", modifier = Modifier.size(16.dp).clickable { onDelete() }, tint = MaterialTheme.colorScheme.error)
        }
        Text(task.prompt, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            nextIn?.let { Text("next in ${TranscriptHelpers.formatRelativeIn(it - System.currentTimeMillis())}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            task.lastFiredAt?.let { Text("fired ${TranscriptHelpers.formatRelativeAgo(System.currentTimeMillis() - it)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (task.lastGuardResult == "skipped" && task.lastSkipReason != null) {
                Text("skip: ${task.lastSkipReason}", style = MaterialTheme.typography.labelSmall, color = AMBER, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun CronCreateForm(claudeSessionId: String, onDone: () -> Unit) {
    var recurring by remember { mutableStateOf(true) }
    var trigger by remember { mutableStateOf("*/5 * * * *") }
    var prompt by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val preview = remember(trigger, recurring) {
        if (!recurring) null
        else runCatching { CronExpr.nextRuns(trigger, System.currentTimeMillis(), 3) }.getOrElse { emptyList() }
    }
    val triggerValid = if (recurring) CronExpr.isValid(trigger) else trigger.isNotBlank()

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = { recurring = true }, enabled = !recurring, modifier = Modifier.weight(1f)) { Text("Recurring") }
            OutlinedButton(onClick = { recurring = false }, enabled = recurring, modifier = Modifier.weight(1f)) { Text("One-shot") }
        }
        OutlinedTextField(
            value = trigger, onValueChange = { trigger = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            label = { Text(if (recurring) "Cron expression" else "ISO datetime / +30m") },
            isError = !triggerValid,
        )
        if (recurring) {
            if (!triggerValid) Text("Invalid cron expression", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            else preview?.takeIf { it.isNotEmpty() }?.let {
                val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                Text("next: " + it.joinToString(" · ") { ms -> fmt.format(Date(ms)) }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        OutlinedTextField(value = prompt, onValueChange = { prompt = it }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth(), label = { Text("Prompt (sent each fire)") })
        error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = prompt.isNotBlank() && triggerValid && !submitting,
            onClick = {
                submitting = true; error = null
                scope.launch {
                    val trig = if (recurring) trigger.trim() else resolveOneShot(trigger.trim())
                    val err = Cron.add(claudeSessionId, trig, prompt.trim(), recurring)
                    submitting = false
                    if (err == null) onDone() else error = err
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (recurring) "Schedule" else "Schedule once") }
    }
}

/** Resolve `+30m`/`+2h`/`+1d` or leave an ISO string as-is. */
private fun resolveOneShot(input: String): String {
    val m = Regex("""^\+(\d+)([mhd])$""").find(input.trim()) ?: return input
    val n = m.groupValues[1].toLong()
    val unit = m.groupValues[2]
    val ms = when (unit) { "m" -> n * 60_000; "h" -> n * 3_600_000; else -> n * 86_400_000 }
    val instant = java.time.Instant.ofEpochMilli(System.currentTimeMillis() + ms)
    return instant.toString()
}

// ------------------------------------------------------------------ //
// Delegation tasks sheet

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksSheet(repo: AgentsRepository, tasks: List<AgentsRepository.AgentTask>, onOpenSession: (String) -> Unit, onDismiss: () -> Unit) {
    val roles by repo.roles.collectAsState()
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    val open = tasks.filter { it.status in setOf("pending", "in_progress", "blocked") }.sortedByDescending { it.updatedAt }
    val recent = tasks.filter { it.status in setOf("done", "failed", "cancelled") }.sortedByDescending { it.updatedAt }.take(8)
    fun titleOf(key: String) = roles.firstOrNull { it.key == key }?.title ?: key
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Delegation tasks · ${open.size} open", style = MaterialTheme.typography.titleMedium)
            if (open.isEmpty() && recent.isEmpty()) Text("No tasks yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            for (task in open) TaskRow(task, ::titleOf, sessions, onOpenSession, onCancel = { repo.cancelTask(task.id) })
            if (recent.isNotEmpty()) {
                Text("Recent", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                for (task in recent) TaskRow(task, ::titleOf, sessions, onOpenSession, onCancel = null)
            }
            Box(Modifier.size(20.dp))
        }
    }
}

@Composable
private fun TaskRow(
    task: AgentsRepository.AgentTask,
    titleOf: (String) -> String,
    sessions: List<io.amar.console.data.db.AgentSessionRow>,
    onOpenSession: (String) -> Unit,
    onCancel: (() -> Unit)?,
) {
    val statusColor = when (task.status) {
        "in_progress" -> AMBER
        "blocked", "failed" -> RED
        "done" -> GREEN
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)).padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.status.replace("_", " "), style = MaterialTheme.typography.labelSmall, color = statusColor)
            Text(task.title, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            val live = sessions.firstOrNull { it.agentKey == task.toKey && it.status != "ended" }
            if (live != null) Icon(Icons.Filled.PlayArrow, contentDescription = "Open", modifier = Modifier.size(18.dp).clickable { onOpenSession(live.id) }, tint = MaterialTheme.colorScheme.primary)
            if (onCancel != null) Icon(Icons.Filled.Block, contentDescription = "Cancel", modifier = Modifier.size(16.dp).clickable { onCancel() }, tint = MaterialTheme.colorScheme.error)
        }
        val chainLabel = buildString {
            if (task.origin == "human") append("Yousef → ")
            append(task.chain.joinToString(" → ") { titleOf(it) })
        }
        Text(chainLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        task.result?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
