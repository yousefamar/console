package io.amar.console.ui.agents

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository

/**
 * The active session's live task list (CLI TaskCreate/TaskUpdate), pinned
 * above the composer — SPA TodoPanel parity. Header = "Tasks N/M · <current>",
 * tap to expand/collapse; auto-collapses once everything's done (a finished
 * list is history, but the count stays visible).
 */
@Composable
fun TodoPanel(todos: List<AgentsRepository.TodoItem>) {
    if (todos.isEmpty()) return
    val done = todos.count { it.status == "completed" }
    val current = todos.firstOrNull { it.status == "in_progress" }
    val allDone = done == todos.size
    // Nullable OVERRIDE, not a plain boolean: with `collapsed || allDone` a
    // completed list could never be opened (the tap wrote true over a value
    // already forced true).
    var collapsed by remember { mutableStateOf<Boolean?>(null) }
    val isCollapsed = collapsed ?: allDone

    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            Modifier.fillMaxWidth().clickable { collapsed = !isCollapsed }
                .padding(horizontal = 12.dp, vertical = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.AutoMirrored.Filled.List, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
            Text("Tasks", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
            Text("$done/${todos.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            current?.let {
                Text(
                    "· ${todoLabel(it)}", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
            }
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            Icon(
                if (isCollapsed) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = if (isCollapsed) "Expand tasks" else "Collapse tasks",
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp),
            )
        }
        if (!isCollapsed) {
            Column(
                Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 12.dp, bottom = 5.dp),
            ) {
                for (t in todos) TodoRow(t)
            }
        }
    }
}

fun todoLabel(t: AgentsRepository.TodoItem): String =
    if (t.status == "in_progress") (t.activeForm ?: t.subject) else t.subject

@Composable
private fun TodoRow(t: AgentsRepository.TodoItem) {
    Row(
        Modifier.padding(top = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        when (t.status) {
            "completed" -> Icon(Icons.Filled.Check, contentDescription = null, tint = androidx.compose.ui.graphics.Color(0xFF4ADE80), modifier = Modifier.size(12.dp).padding(top = 1.dp))
            "in_progress" -> CircularProgressIndicator(modifier = Modifier.size(11.dp), strokeWidth = 1.5.dp, color = MaterialTheme.colorScheme.tertiary)
            else -> Icon(Icons.Filled.Circle, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f), modifier = Modifier.size(9.dp).padding(top = 2.dp))
        }
        Text(
            todoLabel(t),
            style = MaterialTheme.typography.bodySmall.let {
                if (t.status == "completed") it.copy(textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough) else it
            },
            fontWeight = if (t.status == "in_progress") FontWeight.Medium else null,
            color = if (t.status == "in_progress") MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
