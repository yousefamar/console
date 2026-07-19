package io.amar.console.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.amar.console.ConsoleApp
import io.amar.console.ui.components.CountPill
import io.amar.console.ui.nav.Pane
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * L0 launcher: the app grid. One tile per pane with live unread badges
 * (chat rooms, mail threads, agent attention) and today's next event as a
 * subtitle on Calendar. This is the hub of the surface hierarchy — every
 * app opens from here and back always returns here.
 */
@Composable
fun GridScreen(app: ConsoleApp, onOpen: (Pane) -> Unit) {
    val chatUnread by app.graph.db.chatRooms()
        .observeUnreadCount(System.currentTimeMillis()).collectAsState(initial = 0)
    val mailUnread by app.graph.db.mailThreads().observeUnreadCount().collectAsState(initial = 0)
    val sessions by app.graph.agents.observeSessions().collectAsState(initial = emptyList())
    val agentAlerts = sessions.count { it.needsAttention || it.hasUnread }
    val approvals by app.graph.agents.approvals.collectAsState()
    val nextEvent by app.graph.calendar
        .observeEvents(System.currentTimeMillis(), System.currentTimeMillis() + 24 * 3600_000)
        .collectAsState(initial = emptyList())

    Column(Modifier.fillMaxSize()) {
        // Console wordmark + clock row — the launcher is also a glance screen.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Console",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text(
                SimpleDateFormat("EEE d MMM", Locale.UK).format(Date()),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(Pane.entries.toList(), key = { it.route }) { pane ->
                val badge = when (pane) {
                    Pane.Chat -> chatUnread
                    Pane.Mail -> mailUnread
                    Pane.Agents -> agentAlerts + approvals.size
                    else -> 0
                }
                val subtitle = when (pane) {
                    Pane.Calendar -> nextEvent.firstOrNull { it.startTime > System.currentTimeMillis() }
                        ?.let {
                            SimpleDateFormat("HH:mm", Locale.UK).format(Date(it.startTime)) +
                                " " + it.summary.take(14)
                        }
                    Pane.Agents -> if (approvals.isNotEmpty()) "approval waiting" else null
                    else -> null
                }
                GridTile(pane, badge, subtitle, urgent = pane == Pane.Agents && approvals.isNotEmpty()) {
                    onOpen(pane)
                }
            }
        }
    }
}

@Composable
private fun GridTile(
    pane: Pane,
    badge: Int,
    subtitle: String?,
    urgent: Boolean,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable(onClick = onClick),
    ) {
        Column(
            Modifier.fillMaxSize().padding(10.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                pane.icon,
                contentDescription = pane.label,
                tint = if (urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(30.dp),
            )
            Text(
                pane.label,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(top = 6.dp),
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        if (badge > 0) {
            Box(Modifier.align(Alignment.TopEnd).padding(8.dp)) {
                CountPill(badge)
            }
        }
    }
}
