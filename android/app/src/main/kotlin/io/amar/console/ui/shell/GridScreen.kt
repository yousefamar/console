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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.amar.console.ConsoleApp
import io.amar.console.core.HubPrefs
import io.amar.console.ui.components.CountPill
import io.amar.console.ui.nav.Pane
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * L0 launcher: the app grid. One tile per pane with live unread badges
 * (chat rooms, mail threads, feeds unread, agent attention, notes dirty
 * files) and today's next event as a subtitle on Calendar. This is the hub of
 * the surface hierarchy — every app opens from here and back always returns
 * here.
 *
 * Parity notes (FEATURES app-wide #16/#17/#21):
 *  - Feeds tile → total unread count; Notes tile → dirty (unsaved) open files.
 *  - Agents tile turns urgent (error tint) + shows a red attention dot when a
 *    session raised @amar. Notes tile shows a red dot while the pen is
 *    live-streaming strokes.
 *  - A BellOff indicator in the header appears only while Do Not Disturb is on;
 *    tapping it disables DND (hub-synced pref).
 */
@Composable
fun GridScreen(app: ConsoleApp, onOpen: (Pane) -> Unit) {
    val chatUnread by app.graph.db.chatRooms()
        .observeUnreadCount(System.currentTimeMillis()).collectAsState(initial = 0)
    val mailUnread by app.graph.db.mailThreads().observeUnreadCount().collectAsState(initial = 0)
    val sessions by app.graph.agents.observeSessions().collectAsState(initial = emptyList())
    val agentAlerts = sessions.count { it.needsAttention || it.hasUnread }
    val agentAttention = sessions.any { it.needsAttention }
    val approvals by app.graph.agents.approvals.collectAsState()
    val nextEvent by app.graph.calendar
        .observeEvents(System.currentTimeMillis(), System.currentTimeMillis() + 24 * 3600_000)
        .collectAsState(initial = emptyList())

    // Feeds total unread — items not in the read set (mirrors FeedsScreen).
    val feedItems by app.graph.feeds.observeItems().collectAsState(initial = emptyList())
    val feedReadIds by app.graph.feeds.observeReadIds().collectAsState(initial = emptyList())
    val feedUnread = run {
        val read = feedReadIds.toHashSet()
        feedItems.count { it.id !in read }
    }

    // Notes: dirty (unsaved) open tabs + pen live-streaming red dot.
    val notesTabs by app.graph.notes.tabs.state.collectAsState()
    val notesDirty = notesTabs.open.count { it.dirty }
    val penStreaming by app.graph.notes.penStreaming.collectAsState()
    val penActiveAt by app.graph.notes.penActiveAt.collectAsState()
    val penDot = penStreaming || (System.currentTimeMillis() - penActiveAt < 60_000)

    // Collect prefs so the DND indicator re-renders on toggle; value read via HubPrefs.
    val prefs by HubPrefs.prefs.collectAsState()
    val dnd = (prefs["dnd"] as? JsonPrimitive)?.booleanOrNull ?: false
    val scope = rememberCoroutineScope()

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
            if (dnd) {
                // BellOff indicator — visible only while DND is on; tap disables.
                Icon(
                    Icons.Outlined.NotificationsOff,
                    contentDescription = "Do Not Disturb is on — tap to disable",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .clickable { scope.launch { HubPrefs.setDnd(app.graph.hub, false) } }
                        .padding(1.dp),
                )
            }
            Text(
                SimpleDateFormat("EEE d MMM", Locale.UK).format(Date()),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 10.dp),
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
                    Pane.Feeds -> feedUnread
                    Pane.Notes -> notesDirty
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
                // Red attention dot: agents (@amar) or notes (pen streaming).
                val dot = when (pane) {
                    Pane.Agents -> agentAttention
                    Pane.Notes -> penDot
                    else -> false
                }
                GridTile(
                    pane, badge, subtitle,
                    urgent = pane == Pane.Agents && approvals.isNotEmpty(),
                    attentionDot = dot,
                ) {
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
    attentionDot: Boolean,
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
        // Red attention dot (top-right, above/beside any count pill).
        if (attentionDot) {
            Box(
                Modifier
                    .align(Alignment.TopStart)
                    .padding(8.dp)
                    .size(9.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.error),
            )
        }
    }
}
