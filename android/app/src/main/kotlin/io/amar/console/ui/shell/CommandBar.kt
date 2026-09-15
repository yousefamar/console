package io.amar.console.ui.shell

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.ConsoleApp
import io.amar.console.core.InstalledApps
import io.amar.console.data.db.MailThreadRow
import io.amar.console.data.feeds.relativeTime
import io.amar.console.data.search.CommandBarLogic
import io.amar.console.data.search.CommandBarLogic.Entry
import io.amar.console.data.search.CommandBarLogic.Kind
import io.amar.console.data.search.CommandBarLogic.Target
import io.amar.console.ui.theme.accents
import kotlinx.coroutines.delay

/** Stable key for an installed app across the ranker and the launch map. */
fun appKey(e: InstalledApps.Entry): String = e.packageName + "/" + e.activityName + "@" + e.user.hashCode()

/**
 * The launcher command bar's result list — SPA `CommandBar.tsx` under the
 * grid's search field. Composed only while a query is typed, so its Room
 * flows are collected only then. Every source is local (Room / already-loaded
 * StateFlows): no hub call in the query path, offline by construction.
 *
 * [installedApps]/[usage] come from the grid (it already holds them for the
 * drawer); every pick — apps included — goes to [onPick], which the grid
 * resolves (app launch) or hands to the shell to route through the existing
 * nav primitives.
 */
@Composable
fun CommandBarResults(
    app: ConsoleApp,
    query: String,
    installedApps: List<InstalledApps.Entry>,
    usage: Map<String, Pair<Int, Long>>,
    onPick: (Target) -> Unit,
    /** Reported on every recompute so the search field's IME action can open the top hit. */
    onResults: (List<Entry>) -> Unit,
) {
    val now = remember { System.currentTimeMillis() }

    val spaces by app.graph.spaces.spaces.collectAsState()
    val sessions by app.graph.agents.observeSessions().collectAsState(initial = emptyList())
    val activity by app.graph.agents.activity.collectAsState()
    val files by app.graph.notes.observeFiles().collectAsState(initial = emptyList())
    val rooms by app.graph.chat.observeRooms().collectAsState(initial = emptyList())
    val recentThreads by app.graph.mail.observeRecent(CommandBarLogic.RECENT_THREADS).collectAsState(initial = emptyList())
    val feeds by app.graph.feeds.observeFeeds().collectAsState(initial = emptyList())
    val bookmarks by app.graph.bookmarks.observeAll().collectAsState(initial = emptyList())
    // Still-running or future only: read from yesterday, drop what has ended.
    val eventRows by app.graph.calendar
        .observeEvents(now - CommandBarLogic.DAY_MS, now + CommandBarLogic.UPCOMING_DAYS * CommandBarLogic.DAY_MS)
        .collectAsState(initial = emptyList())

    // Whole-table mail hits join the recent pool from 2 chars (debounced).
    var threadHits by remember { mutableStateOf<List<MailThreadRow>>(emptyList()) }
    LaunchedEffect(query) {
        val q = query.trim()
        if (q.length < 2) { threadHits = emptyList(); return@LaunchedEffect }
        delay(120)
        threadHits = runCatching { app.graph.mail.search(q).take(CommandBarLogic.THREAD_HITS) }.getOrDefault(emptyList())
    }

    val appsByKey = remember(installedApps) { installedApps.associateBy { appKey(it) } }
    val appRefs = remember(installedApps, usage) {
        installedApps.map { e ->
            val u = usage[e.packageName]
            CommandBarLogic.AppRef(appKey(e), e.label, u?.first ?: 0, u?.second ?: 0L, InstalledApps.isWorkProfile(e))
        }
    }
    val entries = remember(spaces, sessions, activity, files, rooms, recentThreads, threadHits, feeds, bookmarks, eventRows, appRefs) {
        CommandBarLogic.build(
            CommandBarLogic.Sources(
                apps = appRefs,
                spaces = spaces,
                sessions = sessions,
                running = activity.filterValues { it.running }.keys,
                files = files,
                rooms = rooms,
                threads = recentThreads + threadHits,
                feeds = feeds,
                bookmarks = bookmarks,
                events = CommandBarLogic.upcomingEvents(eventRows, now),
            ),
        )
    }
    val results = remember(entries, query) {
        val ranked = CommandBarLogic.rank(entries, query)
        CommandBarLogic.createEntry(query)?.let { ranked + it } ?: ranked
    }
    LaunchedEffect(results) { onResults(results) }

    LazyColumn(Modifier.fillMaxSize()) {
        if (results.isEmpty()) {
            item {
                Text(
                    "Nothing matches", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp), textAlign = TextAlign.Center,
                )
            }
        }
        items(results, key = { it.key }) { e ->
            CommandBarRow(e, appIcon = (e.target as? Target.App)?.let { appsByKey[it.key]?.icon }, now = now) { onPick(e.target) }
        }
    }
}

@Composable
private fun CommandBarRow(e: Entry, appIcon: android.graphics.drawable.Drawable?, now: Long, onClick: () -> Unit) {
    val tint = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp, horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        KindGlyph(e, appIcon, tint)
        // Title takes the slack; the hint is width-bounded so it can never be
        // starved to a one-char-per-line column (the Row trap).
        Text(
            e.title, style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        e.hint?.let {
            Text(
                it, style = MaterialTheme.typography.labelSmall, color = tint,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp),
            )
        }
        if (e.unread) Box(Modifier.size(6.dp).clip(CircleShape).background(MaterialTheme.accents.blue))
        if (e.running) Box(Modifier.size(6.dp).clip(CircleShape).background(MaterialTheme.accents.amber))
        if (e.recency > 0 && e.kind in CommandBarLogic.TIMESTAMPED) {
            Text(relativeTime(e.recency, now), style = MaterialTheme.typography.labelSmall, color = tint)
        }
    }
}

@Composable
private fun KindGlyph(e: Entry, appIcon: android.graphics.drawable.Drawable?, tint: Color) {
    if (e.kind == Kind.APP) {
        val bmp = remember(e.key) {
            runCatching {
                val d = appIcon ?: return@remember null
                val b = android.graphics.Bitmap.createBitmap(48, 48, android.graphics.Bitmap.Config.ARGB_8888)
                d.setBounds(0, 0, 48, 48); d.draw(android.graphics.Canvas(b)); b.asImageBitmap()
            }.getOrNull()
        }
        if (bmp != null) Image(bmp, contentDescription = null, modifier = Modifier.size(18.dp))
        else Icon(Icons.Filled.Apps, null, Modifier.size(16.dp), tint = tint)
        return
    }
    val (vector, color) = when (e.kind) {
        Kind.PANE -> ((e.target as? Target.OpenPane)?.pane?.icon ?: Icons.Filled.Apps) to MaterialTheme.colorScheme.primary
        Kind.ACTION -> Icons.Filled.Bolt to tint
        Kind.AREA -> Icons.Filled.Tag to tint
        Kind.PROJECT -> Icons.Filled.ViewKanban to tint
        Kind.SESSION -> if (e.isFork) Icons.AutoMirrored.Filled.CallSplit to MaterialTheme.accents.violet.copy(alpha = 0.7f) else Icons.Filled.SmartToy to tint
        Kind.FILE -> Icons.AutoMirrored.Filled.InsertDriveFile to tint
        Kind.ROOM -> Icons.AutoMirrored.Outlined.Chat to tint
        Kind.THREAD -> Icons.Outlined.Email to tint
        Kind.FEED -> Icons.Outlined.RssFeed to tint
        Kind.BOOKMARK -> Icons.Outlined.Bookmarks to tint
        Kind.EVENT -> Icons.Outlined.CalendarMonth to tint
        Kind.CREATE -> Icons.Filled.Add to tint
        Kind.APP -> Icons.Filled.Apps to tint
    }
    Icon(vector, null, Modifier.size(16.dp), tint = color)
}
