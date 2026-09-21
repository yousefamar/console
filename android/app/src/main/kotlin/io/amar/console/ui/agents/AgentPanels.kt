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
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CallSplit
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Sensors
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import io.amar.console.ui.theme.accents
import androidx.compose.runtime.ReadOnlyComposable
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
import androidx.compose.ui.draw.alpha
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
import io.amar.console.data.agents.Listeners
import io.amar.console.ui.shell.AppToast
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

private val AMBER: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.amber
private val VIOLET: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.violet
private val GREEN: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.green
private val RED: Color @Composable @ReadOnlyComposable get() = MaterialTheme.accents.red

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
    val chips = remember(task) {
        val now = System.currentTimeMillis()
        val computedNext = if (task.disabledAt != null || task.nextFireAt != null) null
        else runCatching { CronExpr.nextRuns(task.trigger, now, 1).firstOrNull() }.getOrNull()
        Cron.statusChips(task, now, computedNext, TranscriptHelpers::formatRelativeIn, TranscriptHelpers::formatRelativeAgo)
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
            chips.next?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            chips.last?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            chips.skip?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = AMBER, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
        OutlinedTextField(value = prompt, onValueChange = { prompt = it }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth(), label = { Text("Prompt (sent each fire)") }, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences))
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
// Listener sheet — the ListenerPanel.tsx twin. Shares the status bar's
// one sheet slot with CronSheet. No create form: rules come from
// `con listen add` in the session itself.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListenerSheet(claudeSessionId: String, onDismiss: () -> Unit) {
    val listeners by Listeners.listenersFor(claudeSessionId).collectAsState(initial = emptyList())
    val error by Listeners.errorFor(claudeSessionId).collectAsState(initial = null)
    LaunchedEffect(claudeSessionId) { Listeners.refresh(claudeSessionId) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Event listeners", style = MaterialTheme.typography.titleMedium)
            error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
            if (listeners.isEmpty() && error == null) {
                Text("No listeners for this session.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            for (l in listeners) ListenerRow(l)
            Text("con listen add --on <topic> …", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            Box(Modifier.size(20.dp))
        }
    }
}

@Composable
private fun ListenerRow(l: Listeners.Listener) {
    val scope = rememberCoroutineScope()
    var busy by remember(l.id) { mutableStateOf(false) }
    val now = System.currentTimeMillis()
    val dateFmt = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }
    val fmtDate: (Long) -> String = { dateFmt.format(Date(it)) }
    val rule = remember(l) { Listeners.listenerSummary(l, fmtDate) }
    val chip = Listeners.stateChip(l, now, TranscriptHelpers::formatRelativeIn)
    val meta = Listeners.statsLine(l, now, TranscriptHelpers::formatRelativeAgo) +
        Listeners.gates(l).joinToString(", ").let { if (it.isEmpty()) emptyList() else listOf(it) } +
        Listeners.life(l, now, TranscriptHelpers::formatRelativeIn).joinToString(", ").let { if (it.isEmpty()) emptyList() else listOf(it) }
    val outcome = l.stats.lastOutcome
    val canFlush = (l.pending != null || Listeners.nextDeadline(l) != null) && !l.paused && l.active
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    fun run(verb: suspend () -> String?) {
        if (busy) return
        busy = true
        scope.launch {
            val err = verb()
            busy = false
            if (err != null) AppToast.show(err, error = true)
        }
    }

    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)).padding(8.dp)
            .let { if (!l.active) it.alpha(0.6f) else it },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Filled.Sensors, contentDescription = null, modifier = Modifier.size(11.dp), tint = if (l.paused || !l.active) muted else GREEN)
            Text(rule, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            chip?.let {
                Text(
                    it.text, style = MaterialTheme.typography.labelSmall, maxLines = 1,
                    color = when (it.kind) { Listeners.StateKind.DISABLED -> RED; Listeners.StateKind.PAUSED -> AMBER; Listeners.StateKind.INFO -> muted },
                )
            }
        }
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (l.action.type == "wake" && l.action.fork) Icon(Icons.Filled.CallSplit, contentDescription = "fork", modifier = Modifier.size(11.dp).padding(top = 2.dp), tint = muted)
            Text(Listeners.actionLine(l), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        l.name?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        Text(meta.joinToString("   "), style = MaterialTheme.typography.labelSmall, color = muted)
        outcome?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = if (Listeners.outcomeBad(it)) AMBER else muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            if (busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            if (canFlush) {
                TextButton(enabled = !busy, onClick = { run { Listeners.flush(l.id) } }) {
                    Icon(Icons.Filled.Bolt, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(if (l.expect != null) " Judge now" else " Fire now", style = MaterialTheme.typography.labelSmall)
                }
            }
            if (l.paused || !l.active) {
                TextButton(enabled = !busy, onClick = { run { Listeners.resume(l.id) } }) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(if (!l.active) " Re-enable" else " Resume", style = MaterialTheme.typography.labelSmall)
                }
            } else {
                TextButton(enabled = !busy, onClick = { run { Listeners.pause(l.id) } }) {
                    Icon(Icons.Filled.Pause, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(" Pause", style = MaterialTheme.typography.labelSmall)
                }
            }
            TextButton(enabled = !busy, onClick = { run { Listeners.remove(l.id) } }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(14.dp))
                Text(" Remove", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

// ------------------------------------------------------------------ //
// Delegation tasks sheet


