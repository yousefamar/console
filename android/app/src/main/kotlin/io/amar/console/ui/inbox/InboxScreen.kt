package io.amar.console.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.amar.console.data.chat.SnoozeTimes
import io.amar.console.data.inbox.InboxEntry
import io.amar.console.data.inbox.InboxRepository
import io.amar.console.data.inbox.InboxSource
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.NetworkBadge
import io.amar.console.ui.components.PaneTopBar
import io.amar.console.ui.components.RelativeTime
import kotlinx.coroutines.delay

/**
 * Unified Inbox — native twin of the SPA's InboxTab in its MOBILE mode:
 * one list at a time (Inbox | Feed segmented toggle), tapping an item opens
 * the source's existing detail screen (chat room / mail thread / feed item /
 * agent session) so viewers are reused, not rebuilt. Handling an item there
 * (read/archive) drops it from these lists identically — membership is
 * derived, never stored here.
 *
 * Swipe right = done (archive mail / read chat·feed·agent); swipe left =
 * snooze (mail/chat/feed until tomorrow 8am; agents don't snooze).
 */
@Composable
fun InboxScreen(
    repo: InboxRepository,
    onOpenChat: (String) -> Unit,
    onOpenMail: (String) -> Unit,
    onOpenFeedItem: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    onDone: (InboxEntry) -> Unit,
    /** Snooze mail/chat until tomorrow morning (feed snooze is local to the
     *  repo; agents don't snooze). */
    onSnooze: (InboxEntry) -> Unit,
    onGrid: () -> Unit = {},
) {
    val lists by repo.lists.collectAsState()
    val xOnly by repo.xOnlyMode.collectAsState()
    var showFeed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { repo.refreshRules() }

    val entries = if (showFeed) lists.feed else lists.inbox

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = "Inbox",
            onGrid = onGrid,
            actions = {
                if (showFeed) {
                    TextButton(onClick = { repo.setXOnly(!xOnly) }) {
                        Text(if (xOnly) "𝕏 only" else "𝕏", fontSize = 13.sp)
                    }
                }
            },
        )
        SingleChoiceSegmentedButtonRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        ) {
            SegmentedButton(
                selected = !showFeed,
                onClick = { showFeed = false },
                shape = SegmentedButtonDefaults.itemShape(0, 2),
            ) { Text("Inbox · ${lists.inbox.size}") }
            SegmentedButton(
                selected = showFeed,
                onClick = { showFeed = true },
                shape = SegmentedButtonDefaults.itemShape(1, 2),
            ) { Text("Feed · ${lists.feed.size}") }
        }
        if (entries.isEmpty()) {
            EmptyState(
                Icons.Outlined.Inbox,
                if (showFeed) "Nothing to browse" else "Inbox zero",
            )
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(entries, key = { it.key }) { entry ->
                    val dismissState = rememberSwipeToDismissBoxState(
                        confirmValueChange = { value ->
                            when (value) {
                                SwipeToDismissBoxValue.StartToEnd -> { onDone(entry); true }
                                SwipeToDismissBoxValue.EndToStart -> {
                                    if (entry.source == InboxSource.AGENT) false
                                    else {
                                        if (entry.source == InboxSource.FEED)
                                            repo.snoozeFeedItem(entry.sourceId, SnoozeTimes.tomorrowMorning())
                                        else onSnooze(entry)
                                        true
                                    }
                                }
                                else -> false
                            }
                        },
                    )
                    // A confirmed swipe relies on the ACTION dropping the entry
                    // from the derived list. If the row is still here 1.5 s later
                    // the action didn't remove it (^quick-ram: "done" on a read
                    // overdue DM was a no-op and rows froze on "Done") — snap it
                    // back so a no-op reads as a bounce, never a stuck hint.
                    LaunchedEffect(dismissState.currentValue) {
                        if (dismissState.currentValue != SwipeToDismissBoxValue.Settled) {
                            delay(1_500)
                            dismissState.reset()
                        }
                    }
                    SwipeToDismissBox(
                        state = dismissState,
                        backgroundContent = { SwipeHint(dismissState.dismissDirection) },
                    ) {
                        InboxRow(
                            entry = entry,
                            onClick = {
                                when (entry.source) {
                                    InboxSource.CHAT -> onOpenChat(entry.sourceId)
                                    InboxSource.MAIL -> onOpenMail(entry.sourceId)
                                    InboxSource.FEED -> onOpenFeedItem(entry.sourceId)
                                    InboxSource.AGENT -> onOpenSession(entry.sourceId)
                                }
                            },
                            onToggleRoute = { repo.toggleRoute(entry) },
                        )
                    }
                    HorizontalDivider(thickness = 0.5.dp)
                }
            }
        }
    }
}

@Composable
private fun SwipeHint(direction: SwipeToDismissBoxValue) {
    val (label, align) = when (direction) {
        SwipeToDismissBoxValue.StartToEnd -> "Done" to Alignment.CenterStart
        SwipeToDismissBoxValue.EndToStart -> "Snooze" to Alignment.CenterEnd
        else -> return
    }
    Box(
        Modifier.fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 20.dp),
        contentAlignment = align,
    ) { Text(label, style = MaterialTheme.typography.labelMedium) }
}

@Composable
private fun InboxRow(entry: InboxEntry, onClick: () -> Unit, onToggleRoute: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SourceIcon(entry)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    entry.header,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (entry.overdue) {
                    Text(
                        "OVERDUE",
                        fontSize = 9.sp,
                        color = androidx.compose.ui.graphics.Color(0xFFF59E0B),
                        modifier = Modifier
                            .background(
                                androidx.compose.ui.graphics.Color(0x33F59E0B),
                                RoundedCornerShape(3.dp),
                            )
                            .padding(horizontal = 3.dp),
                    )
                }
            }
            if (entry.body.isNotBlank()) {
                Text(
                    entry.body,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                RelativeTime.format(entry.ts),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (entry.routeKey != null) {
                Text(
                    if (entry.inInbox) "→ feed" else "→ inbox",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(onClick = onToggleRoute).padding(top = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun SourceIcon(entry: InboxEntry) {
    if (entry.source == InboxSource.CHAT && entry.network != null) {
        NetworkBadge(entry.network, size = 20.dp)
        return
    }
    val (icon, tint) = when (entry.source) {
        InboxSource.MAIL -> Icons.Outlined.Email to MaterialTheme.colorScheme.onSurfaceVariant
        InboxSource.FEED -> Icons.Outlined.RssFeed to MaterialTheme.colorScheme.onSurfaceVariant
        InboxSource.AGENT -> Icons.Outlined.SmartToy to
            (if (entry.attention) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        InboxSource.CHAT -> Icons.AutoMirrored.Outlined.Chat to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Icon(icon, contentDescription = entry.source.name, tint = tint, modifier = Modifier.size(20.dp))
}
