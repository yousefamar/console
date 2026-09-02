package io.amar.console.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
 *  - Spaces tile turns urgent (error tint) + shows a red attention dot when a
 *    session raised @amar. Notes tile shows a red dot while the pen is
 *    live-streaming strokes.
 *  - A BellOff indicator in the header appears only while Do Not Disturb is on;
 *    tapping it disables DND (hub-synced pref).
 */
@Composable
fun GridScreen(app: ConsoleApp, onOpen: (Pane) -> Unit) {
    val chatUnread by app.graph.db.chatRooms()
        .observeUnreadCount(System.currentTimeMillis()).collectAsState(initial = 0)
    // Inbox tile = the unified inbox list size (SPA tab-badge parity).
    val inboxLists by app.graph.inbox.lists.collectAsState()
    val inboxCount = inboxLists.inbox.size
    val inboxAttention = inboxLists.inbox.any { it.attention }
    // SPA parity: the Mail badge counts INBOX THREADS (triage left), not unread.
    val mailUnread by app.graph.db.mailThreads().observeInboxCount(System.currentTimeMillis()).collectAsState(initial = 0)
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

        // Launcher search: filters BOTH Console panes and installed apps.
        var query by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf("") }
        val installedApps by io.amar.console.core.InstalledApps.apps.collectAsState()
        val usageVersion by io.amar.console.core.InstalledApps.usageVersion.collectAsState()
        val ctxForUsage = androidx.compose.ui.platform.LocalContext.current
        // Frequency-first ordering (usage ledger learned from launches),
        // recency tiebreak, then alphabetical for never-launched apps.
        val visibleApps = androidx.compose.runtime.remember(installedApps, query, usageVersion) {
            val usage = io.amar.console.core.InstalledApps.usage(ctxForUsage)
            val base = if (query.isBlank()) installedApps
            else installedApps.filter { it.label.contains(query, ignoreCase = true) }
            base.sortedWith(
                compareByDescending<io.amar.console.core.InstalledApps.Entry> { usage[it.packageName]?.first ?: 0 }
                    .thenByDescending { usage[it.packageName]?.second ?: 0L }
                    .thenBy { it.label.lowercase() }
            )
        }
        val visiblePanes = androidx.compose.runtime.remember(query) {
            if (query.isBlank()) Pane.entries.toList()
            else Pane.entries.filter { it.label.contains(query, ignoreCase = true) }
        }
        val ctx = androidx.compose.ui.platform.LocalContext.current
        androidx.compose.material3.OutlinedTextField(
            value = query, onValueChange = { query = it },
            placeholder = { Text("Search apps") }, singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, null, modifier = Modifier.size(18.dp)) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
        )

        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(visiblePanes, key = { it.route }) { pane ->
                val badge = when (pane) {
                    Pane.Inbox -> inboxCount
                    Pane.Chat -> chatUnread
                    Pane.Mail -> mailUnread
                    Pane.Spaces -> agentAlerts + approvals.size
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
                    Pane.Spaces -> if (approvals.isNotEmpty()) "approval waiting" else null
                    else -> null
                }
                // Red attention dot: spaces (@amar sessions), inbox (such a
                // session in its list) or notes (pen streaming).
                val dot = when (pane) {
                    Pane.Spaces -> agentAttention
                    Pane.Inbox -> inboxAttention
                    Pane.Notes -> penDot
                    else -> false
                }
                GridTile(
                    pane, badge, subtitle,
                    urgent = pane == Pane.Spaces && approvals.isNotEmpty(),
                    attentionDot = dot,
                ) {
                    onOpen(pane)
                }
            }

            // ---- App drawer: the rest of the phone, same scroll surface ---- //
            if (visibleApps.isNotEmpty()) {
                item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                    Text(
                        "APPS",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 8.dp, top = 10.dp, bottom = 2.dp),
                    )
                }
                items(
                    visibleApps,
                    key = { "app:" + it.packageName + "/" + it.activityName + "@" + it.user.hashCode() },
                ) { entry ->
                    InstalledAppTile(
                        entry,
                        onLaunch = { io.amar.console.core.InstalledApps.launch(ctx, entry) },
                        onInfo = { io.amar.console.core.InstalledApps.appInfo(ctx, entry) },
                    )
                }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun InstalledAppTile(
    entry: io.amar.console.core.InstalledApps.Entry,
    onLaunch: () -> Unit,
    onInfo: () -> Unit,
) {
    val iconBitmap = androidx.compose.runtime.remember(entry.packageName, entry.user) {
        runCatching {
            val d = entry.icon ?: return@remember null
            val bmp = android.graphics.Bitmap.createBitmap(96, 96, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            d.setBounds(0, 0, 96, 96)
            d.draw(canvas)
            bmp.asImageBitmap()
        }.getOrNull()
    }
    Column(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onLaunch, onLongClick = onInfo)
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (iconBitmap != null) {
            androidx.compose.foundation.Image(iconBitmap, contentDescription = entry.label, modifier = Modifier.size(44.dp))
        }
        Text(
            entry.label + if (io.amar.console.core.InstalledApps.isWorkProfile(entry)) " ⧉" else "",
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 4.dp, start = 2.dp, end = 2.dp),
        )
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
                    .background(MaterialTheme.colorScheme.error)
                    .semantics {
                        contentDescription = if (pane == Pane.Notes) "Pen is streaming into Notes"
                        else "A session wants your attention"
                    },
            )
        }
    }
}
