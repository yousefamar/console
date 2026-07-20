package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.agents.Cron
import io.amar.console.data.db.AgentSessionRow

private val AMBER = Color(0xFFF59E0B)
private val GREEN = Color(0xFF4ADE80)
private val RED = Color(0xFFF87171)

/**
 * Per-session status bar: model pin picker · permission-mode badge · git
 * branch/stats · sub-agent counter · cron pill · context-usage meter.
 * Ported from AgentSessionView.tsx:216-296.
 */
@Composable
fun StatusBar(
    repo: AgentsRepository,
    session: AgentSessionRow?,
    act: AgentsRepository.Activity?,
    modelState: AgentsRepository.ModelState,
    sessionId: String,
) {
    if (session == null) return
    val usage = repo.contextUsage.collectAsState().value[sessionId]
    var showCron by remember { mutableStateOf(false) }
    var showModelMenu by remember { mutableStateOf(false) }
    val cronTasks by Cron.tasksFor(session.claudeSessionId).collectAsState(initial = emptyList())
    val activeCron = cronTasks.count { it.disabledAt == null }

    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Model pin picker (Al shows a plain label).
            if (session.id == "al") {
                session.modelLabel?.let { Text(it, style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else {
                Box {
                    Row(
                        Modifier.clickable { showModelMenu = true },
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (session.modelOverride != null) Icon(Icons.Filled.PushPin, contentDescription = "Pinned", tint = AMBER, modifier = Modifier.size(11.dp))
                        Text(
                            TranscriptHelpers.shortModel(session.modelOverride ?: session.modelLabel ?: modelState.model),
                            style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                            color = if (session.modelOverride != null) AMBER else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    DropdownMenu(expanded = showModelMenu, onDismissRequest = { showModelMenu = false }) {
                        val options = (listOf(modelState.model) + modelState.chain + listOfNotNull(session.modelOverride)).distinct()
                        DropdownMenuItem(text = { Text("(hub) — unpin") }, onClick = { repo.setSessionModel(sessionId, null); showModelMenu = false })
                        for (m in options) {
                            DropdownMenuItem(
                                text = { Text(TranscriptHelpers.shortModel(m), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall) },
                                onClick = { repo.setSessionModel(sessionId, m); showModelMenu = false },
                            )
                        }
                    }
                }
            }
            // Permission-mode badge (only when not default).
            val mode = session.permissionMode
            if (mode != null && mode != "default") {
                Text(mode, style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = AMBER)
            }
            // Git branch + stats.
            session.gitBranch?.let { branch ->
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.AccountTree, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(11.dp))
                    Text(branch, style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    when {
                        session.gitAdded >= 0 || session.gitDeleted >= 0 -> {
                            if (session.gitAdded > 0) Text("+${session.gitAdded}", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = GREEN)
                            if (session.gitDeleted > 0) Text("−${session.gitDeleted}", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = RED)
                        }
                        session.gitDirty -> Text("*", style = MaterialTheme.typography.labelSmall, color = AMBER)
                    }
                }
            }
            // Sub-agent counter.
            val subCount = act?.subagents?.size ?: 0
            if (subCount > 0) {
                Text("$subCount sub-agent${if (subCount > 1) "s" else ""}", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = AMBER)
            }
            // Cron pill.
            if (activeCron > 0) {
                Row(
                    Modifier.clickable { showCron = true }.clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)).padding(horizontal = 5.dp, vertical = 1.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Schedule, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(11.dp))
                    Text("cron: $activeCron", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        // Context-usage meter.
        if (usage != null && usage.maxTokens > 0) {
            val frac = (usage.totalTokens.toFloat() / usage.maxTokens).coerceIn(0f, 1f)
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 1.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                LinearProgressIndicator(
                    progress = { frac },
                    modifier = Modifier.weight(1f),
                    color = when { frac > 0.8f -> RED; frac > 0.5f -> AMBER; else -> MaterialTheme.colorScheme.primary },
                )
                Text("${fmtTokens(usage.totalTokens)} / ${fmtTokens(usage.maxTokens)}", style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    if (showCron && session.claudeSessionId != null) {
        CronSheet(claudeSessionId = session.claudeSessionId, onDismiss = { showCron = false })
    }
}

private fun fmtTokens(n: Long): String = when {
    n >= 1_000_000 -> "${"%.1f".format(n / 1_000_000.0)}M"
    n >= 1_000 -> "${n / 1000}k"
    else -> "$n"
}
