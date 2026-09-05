package io.amar.console.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Article
import androidx.compose.material.icons.outlined.AssignmentTurnedIn
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import io.amar.console.data.inbox.FeedKind
import io.amar.console.data.inbox.InboxEntry
import io.amar.console.data.inbox.InboxRepository
import io.amar.console.data.inbox.InboxSource
import io.amar.console.data.inbox.feedKindsPresent
import io.amar.console.data.inbox.filterByFeedKind
import io.amar.console.data.inbox.reviewHandbacksFor
import io.amar.console.data.spaces.SpacesRepository
import io.amar.console.ui.components.EmptyState
import io.amar.console.ui.components.NetworkBadge
import io.amar.console.ui.components.PaneTopBar
import io.amar.console.ui.components.RelativeTime
import io.amar.console.ui.components.SnoozeSheet
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Unified Inbox — native twin of the SPA's InboxTab in its MOBILE mode:
 * one list at a time (Inbox | Feed segmented toggle), tapping an item opens
 * the source's EXISTING detail screen (chat room / mail thread / feed item /
 * agent session) so viewers are reused, not rebuilt. Handling an item there
 * (read/archive) drops it from these lists identically — membership is
 * derived, never stored here.
 *
 * Swipe right = done (archive mail / read chat·feed·agent), undoable for 5 s.
 * Swipe left = snooze via the shared picker — ANY source, agents included
 * (mail/chat snooze on the hub, feed/agent locally by item key). The Clock
 * toggle swaps the list for everything currently snoozed (soonest due first;
 * swipe right there = unsnooze). Chips narrow the Inbox by source and the
 * Feed by platform; both are session-only.
 */
@Composable
fun InboxScreen(
    repo: InboxRepository,
    spaces: SpacesRepository,
    onOpenChat: (String) -> Unit,
    onOpenMail: (String) -> Unit,
    onOpenFeedItem: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    /** Done for a mail/chat/feed/agent item; returns the undo. */
    onDone: suspend (InboxEntry) -> (suspend () -> Unit)?,
    /** Snooze a MAIL/CHAT item on the hub until [untilMs]. Feed/agent snoozes
     *  are local and handled here. */
    onSnooze: suspend (InboxEntry, Long) -> Unit,
    onUnsnooze: suspend (InboxEntry) -> Unit,
    onGrid: () -> Unit = {},
) {
    val lists by repo.lists.collectAsState()
    val xOnly by repo.xOnlyMode.collectAsState()
    val spaceList by spaces.spaces.collectAsState()
    var showFeed by remember { mutableStateOf(false) }
    var showSnoozed by remember { mutableStateOf(false) }
    var inboxFilter by remember { mutableStateOf<InboxSource?>(null) }
    var feedFilter by remember { mutableStateOf<FeedKind?>(null) }
    var snoozeTarget by remember { mutableStateOf<InboxEntry?>(null) }
    LaunchedEffect(Unit) { repo.refreshRules(); spaces.refreshSpaces() }

    val timeFmt = remember { SimpleDateFormat("EEE HH:mm", Locale.UK) }
    val feedKinds = remember(lists.feed) { feedKindsPresent(lists.feed) }
    val entries = when {
        showSnoozed -> lists.snoozed
        showFeed -> filterByFeedKind(lists.feed, feedFilter)
        else -> if (inboxFilter == null) lists.inbox else lists.inbox.filter { it.source == inboxFilter }
    }

    suspend fun snooze(entry: InboxEntry, until: Long) {
        when (entry.source) {
            InboxSource.FEED, InboxSource.AGENT -> repo.snoozeItem(entry.key, until)
            InboxSource.MAIL, InboxSource.CHAT -> onSnooze(entry, until)
        }
        io.amar.console.ui.shell.UndoController.offer(label = "Snoozed until ${timeFmt.format(Date(until))}") {
            unsnooze(entry, repo, onUnsnooze)
        }
    }

    Column(Modifier.fillMaxSize()) {
        PaneTopBar(
            title = if (showSnoozed) "Snoozed" else "Inbox",
            onGrid = onGrid,
            actions = {
                if (showFeed && !showSnoozed) {
                    TextButton(onClick = { repo.setXOnly(!xOnly) }) {
                        Text(if (xOnly) "𝕏 only" else "𝕏", fontSize = 13.sp)
                    }
                }
                if (lists.snoozed.isNotEmpty() || showSnoozed) {
                    TextButton(onClick = { showSnoozed = !showSnoozed }) {
                        Icon(
                            Icons.Outlined.Schedule, "Snoozed",
                            tint = if (showSnoozed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(" ${lists.snoozed.size}", fontSize = 13.sp)
                    }
                }
            },
        )
        if (!showSnoozed) {
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
            if (showFeed) {
                // One chip per platform present; pointless with a single platform.
                if (feedKinds.size > 1) {
                    ChipRow {
                        for ((kind, count) in feedKinds) {
                            FilterChip(
                                selected = feedFilter == kind,
                                onClick = { feedFilter = if (feedFilter == kind) null else kind },
                                label = { Text("${kind.label} · $count", fontSize = 12.sp) },
                                leadingIcon = { FeedKindGlyph(kind, null, 14.dp) },
                            )
                        }
                    }
                }
            } else {
                val present = InboxSource.entries.filter { s -> lists.inbox.any { it.source == s } }
                if (present.size > 1) {
                    ChipRow {
                        for (s in present) {
                            val count = lists.inbox.count { it.source == s }
                            FilterChip(
                                selected = inboxFilter == s,
                                onClick = { inboxFilter = if (inboxFilter == s) null else s },
                                label = { Text("${sourceLabel(s)} · $count", fontSize = 12.sp) },
                            )
                        }
                    }
                }
            }
        }
        if (entries.isEmpty()) {
            EmptyState(
                if (showSnoozed) Icons.Outlined.Schedule else Icons.Outlined.Inbox,
                when {
                    showSnoozed -> "Nothing snoozed"
                    showFeed -> "Nothing to browse"
                    else -> "Inbox zero"
                },
            )
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(entries, key = { it.key }) { entry ->
                    val dismissState = rememberSwipeToDismissBoxState(
                        confirmValueChange = { value ->
                            when (value) {
                                SwipeToDismissBoxValue.StartToEnd -> {
                                    if (showSnoozed) {
                                        repo.launch { unsnooze(entry, repo, onUnsnooze) }
                                    } else {
                                        repo.launch {
                                            val undo = onDone(entry)
                                            if (undo != null) io.amar.console.ui.shell.UndoController.offer(label = doneLabel(entry), undo = undo)
                                        }
                                    }
                                    true
                                }
                                // Open the picker; the row springs back (false) —
                                // the snooze itself drops it once a time is picked.
                                SwipeToDismissBoxValue.EndToStart -> { if (!showSnoozed) snoozeTarget = entry; false }
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
                        backgroundContent = { SwipeHint(dismissState.dismissDirection, snoozedView = showSnoozed) },
                        enableDismissFromEndToStart = !showSnoozed,
                    ) {
                        InboxRow(
                            entry = entry,
                            handback = entry.source == InboxSource.AGENT &&
                                reviewHandbacksFor(entry.agentKey, spaceList).isNotEmpty(),
                            dueLabel = entry.snoozedUntil?.let { timeFmt.format(Date(it)) },
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

    snoozeTarget?.let { entry ->
        SnoozeSheet(
            onDismiss = { snoozeTarget = null },
            onPick = { until -> repo.launch { snooze(entry, until) }; snoozeTarget = null },
        )
    }
}

private suspend fun unsnooze(entry: InboxEntry, repo: InboxRepository, onUnsnooze: suspend (InboxEntry) -> Unit) {
    when (entry.source) {
        InboxSource.FEED, InboxSource.AGENT -> repo.unsnoozeItem(entry.key)
        InboxSource.MAIL, InboxSource.CHAT -> onUnsnooze(entry)
    }
}

private fun doneLabel(e: InboxEntry): String = when (e.source) {
    InboxSource.MAIL -> "Archived"
    else -> "Marked read"
}

private fun sourceLabel(s: InboxSource): String = when (s) {
    InboxSource.MAIL -> "Mail"
    InboxSource.CHAT -> "Chat"
    InboxSource.FEED -> "Feed"
    InboxSource.AGENT -> "Agents"
}

@Composable
private fun ChipRow(content: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}

@Composable
private fun SwipeHint(direction: SwipeToDismissBoxValue, snoozedView: Boolean) {
    val (label, align) = when (direction) {
        SwipeToDismissBoxValue.StartToEnd -> (if (snoozedView) "Unsnooze" else "Done") to Alignment.CenterStart
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
private fun InboxRow(
    entry: InboxEntry,
    handback: Boolean,
    dueLabel: String?,
    onClick: () -> Unit,
    onToggleRoute: () -> Unit,
) {
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
                if (handback) {
                    Icon(
                        Icons.Outlined.AssignmentTurnedIn, "Card under review",
                        tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp),
                    )
                }
                if (entry.overdue) {
                    Text(
                        "OVERDUE",
                        fontSize = 9.sp,
                        color = Color(0xFFF59E0B),
                        modifier = Modifier
                            .background(Color(0x33F59E0B), RoundedCornerShape(3.dp))
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
        if (entry.image != null) ItemThumb(entry.image)
        Column(horizontalAlignment = Alignment.End) {
            Text(
                dueLabel ?: RelativeTime.format(entry.ts),
                style = MaterialTheme.typography.labelSmall,
                color = if (dueLabel != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (entry.routeKey != null && dueLabel == null) {
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

/** Row-height 16:9 thumbnail; a dead URL renders nothing (row keeps its height). */
@Composable
private fun ItemThumb(url: String) {
    var failed by remember(url) { mutableStateOf(false) }
    if (failed) return
    AsyncImage(
        model = url,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        onError = { failed = true },
        modifier = Modifier.width(64.dp).height(36.dp).clip(RoundedCornerShape(4.dp)),
    )
}

@Composable
private fun SourceIcon(entry: InboxEntry) {
    if (entry.source == InboxSource.CHAT && entry.network != null) {
        NetworkBadge(entry.network, size = 20.dp)
        return
    }
    if (entry.source == InboxSource.FEED) {
        FeedKindGlyph(entry.feedKind ?: FeedKind.RSS, entry.icon, 20.dp)
        return
    }
    val (icon, tint) = when (entry.source) {
        InboxSource.MAIL -> Icons.Outlined.Email to MaterialTheme.colorScheme.onSurfaceVariant
        InboxSource.AGENT -> Icons.Outlined.SmartToy to
            (if (entry.attention) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        else -> Icons.AutoMirrored.Outlined.Chat to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Icon(icon, contentDescription = entry.source.name, tint = tint, modifier = Modifier.size(20.dp))
}

/**
 * Platform mark for a feed row / chip. No brand-icon set ships with the app,
 * so platforms get the closest Material glyph in the platform's colour; plain
 * RSS shows the feed's own favicon when it has one (broken → generic RSS).
 */
@Composable
private fun FeedKindGlyph(kind: FeedKind, favicon: String?, size: androidx.compose.ui.unit.Dp) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (kind) {
        FeedKind.YOUTUBE -> Icon(Icons.Outlined.PlayCircle, "YouTube", tint = Color(0xFFFF0033), modifier = Modifier.size(size))
        FeedKind.REDDIT -> Icon(Icons.Outlined.Forum, "Reddit", tint = Color(0xFFFF4500), modifier = Modifier.size(size))
        FeedKind.HN -> Box(
            Modifier.size(size).background(Color(0xFFFF6600), RoundedCornerShape(2.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("Y", color = Color.White, fontSize = (size.value * 0.6f).sp, fontWeight = FontWeight.Bold) }
        FeedKind.SUBSTACK -> Icon(Icons.Outlined.Article, "Substack", tint = Color(0xFFFF6719), modifier = Modifier.size(size))
        FeedKind.X -> Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            Text("𝕏", color = muted, fontSize = (size.value * 0.75f).sp, fontWeight = FontWeight.Bold)
        }
        FeedKind.RSS -> {
            var failed by remember(favicon) { mutableStateOf(favicon == null) }
            if (failed) Icon(Icons.Outlined.RssFeed, "RSS", tint = muted, modifier = Modifier.size(size))
            else AsyncImage(
                model = favicon,
                contentDescription = "Feed icon",
                onError = { failed = true },
                modifier = Modifier.size(size).clip(RoundedCornerShape(3.dp)),
            )
        }
    }
}
