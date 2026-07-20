package io.amar.console.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.ConsoleApp
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.PaneTopBar
import kotlinx.coroutines.launch

/**
 * Sync-queue inspector — the native surface for the SPA's sync-pill tooltip
 * (FEATURES app-wide #43/#44/#45): lists pending / failed / conflict outbox
 * rows with per-entry Retry + Delete, a Flush-all button, and Copy-error on
 * failed rows. Reads the live outbox Flow so it updates as the drain runs.
 */
@Composable
fun OutboxInspectorScreen(app: ConsoleApp, onBack: () -> Unit) {
    val rows by app.graph.db.outbox().observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Sync queue",
            subtitle = if (rows.isEmpty()) "empty" else "${rows.size} action${if (rows.size == 1) "" else "s"}",
            onBack = onBack,
            actions = {
                TextButton(
                    onClick = { scope.launch { app.graph.outbox.drain() } },
                    enabled = rows.any { it.status == "pending" || it.status == "failed" || it.status == "conflict" },
                ) { Text("Flush") }
            },
        )
        if (rows.isEmpty()) {
            EmptyState(Icons.Filled.Inbox, "Queue is empty", "Offline actions flush here when the hub is back.")
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(rows, key = { it.id }) { row ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(row.type, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        StatusChip(row.status)
                    }
                    row.entityId?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (row.retryCount > 0) {
                        Text("retried ${row.retryCount}×", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    row.error?.let { err ->
                        Text(err, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (row.status == "failed" || row.status == "conflict") {
                            TextButton(onClick = {
                                scope.launch {
                                    app.graph.db.outbox().setStatus(row.id, "pending", null)
                                    app.graph.outbox.scheduleDrain()
                                }
                            }) { Text("Retry") }
                        }
                        row.error?.let { err ->
                            TextButton(onClick = {
                                val cm = context.getSystemService(ClipboardManager::class.java)
                                cm?.setPrimaryClip(ClipData.newPlainText("sync error", err))
                            }) { Text("Copy error") }
                        }
                        TextButton(onClick = { scope.launch { app.graph.db.outbox().delete(row.id) } }) {
                            Text("Delete", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun StatusChip(status: String) {
    val (label, color) = when (status) {
        "failed" -> "failed" to MaterialTheme.colorScheme.error
        "conflict" -> "conflict" to Color(0xFFFBBF24)
        "processing" -> "sending" to MaterialTheme.colorScheme.primary
        else -> "pending" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(label, style = MaterialTheme.typography.labelSmall, color = color)
}
