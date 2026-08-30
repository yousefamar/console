package io.amar.console.ui.spaces

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.data.db.areaList
import io.amar.console.data.spaces.KanbanCodec
import io.amar.console.data.spaces.SpacesRepository
import kotlinx.coroutines.launch

private val VIOLET = Color(0xFFA78BFA)
private val AMBER = Color(0xFFF59E0B)
private val GREEN = Color(0xFF4ADE80)

/**
 * Spaces — the project-first pane that will eventually absorb Notes+Agents
 * (SPA SpacesTab, reshaped for one-hand mobile):
 *
 *   L1 (this screen): space list — Areas, then Projects; alerted spaces
 *       float first with agent-status dots. Tap → space detail.
 *   L2 (SpaceDetailScreen): segmented Board | Agents | Docs.
 *       Board = horizontally-paged columns (Done hidden), tap card → sheet
 *       (move / block / assign is DISPLAY-only — the hub stamps dispatch).
 *       Agents = the space's bound sessions (role project:/areas: join),
 *       tap → the existing agent session screen. Docs = the project's files,
 *       tap → the existing note editor.
 */
@Composable
fun SpacesScreen(
    spacesRepo: SpacesRepository,
    agents: AgentsRepository,
    notes: io.amar.console.data.notes.NotesRepository,
    onOpenSpace: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenNote: (String) -> Unit,
    onGrid: () -> Unit = {},
) {
    val spaces by spacesRepo.spaces.collectAsState()
    val sessions by agents.observeSessions().collectAsState(initial = emptyList())
    val activity by agents.activity.collectAsState()
    // Fleet-level init lived on the retired Agents tab; Spaces is the session
    // surface now. Poll cron cross-client mutations every 30s while mounted.
    LaunchedEffect(Unit) {
        spacesRepo.refreshSpaces()
        io.amar.console.data.agents.Mic.init()
        while (true) { io.amar.console.data.agents.Cron.refreshAll(); kotlinx.coroutines.delay(30_000) }
    }

    fun spaceSessions(slug: String, kind: String): List<AgentSessionRow> =
        sessionsForSpace(slug, kind, sessions)

    // Unsaved (dirty) docs — offline edits awaiting a save/flush.
    val notesFiles by notes.observeFiles().collectAsState(initial = emptyList())

    // Concrete alert ITEMS per space (SPA SpaceAlert parity): the actual
    // unread/alerted sessions + dirty files render as tappable rows inline
    // under the space name, so everything is one tap from the top level.
    fun alertItems(slug: String, kind: String, cardOwned: Set<String>): List<SpaceAlertItem> {
        val bound = spaceSessions(slug, kind)
        fun levelOf(s: AgentSessionRow): String? = when {
            s.needsAttention -> "attention"
            activity[s.id]?.running == true -> "working"
            s.hasUnread -> "unread"
            else -> null
        }
        // Card-owned forks are reachable via their card — suppress from alert
        // rows UNLESS they need you (attention-red always surfaces). SPA
        // ^lean-ibis parity.
        fun suppressed(s: AgentSessionRow): Boolean =
            s.parentClaudeSessionId != null && s.agentKey != null &&
                s.agentKey in cardOwned && !s.needsAttention
        val alerted = bound.filter { levelOf(it) != null && !suppressed(it) }
        // Lineage TREE (SPA ^of1op4): each alerted session pulls its ancestor
        // chain in as context rows (level=null renders neutral), forks nest.
        val byCsid = bound.filter { it.claudeSessionId != null }.associateBy { it.claudeSessionId!! }
        val include = LinkedHashMap<String, AgentSessionRow>() // id → session
        for (s in alerted) {
            val chain = mutableListOf(s)
            var cur = s
            var guard = 0
            while (cur.parentClaudeSessionId != null && guard++ < 6) {
                cur = byCsid[cur.parentClaudeSessionId!!] ?: break
                chain.add(cur)
            }
            for (node in chain.reversed()) include.putIfAbsent(node.id, node)
        }
        // DFS in include-set order, roots first, children under parents.
        val childrenOf = include.values.groupBy { s ->
            s.parentClaudeSessionId?.takeIf { p -> include.values.any { it.claudeSessionId == p } }
        }
        val rank = mapOf("attention" to 0, "working" to 1, "unread" to 2)
        fun sortKey(s: AgentSessionRow) = rank[levelOf(s) ?: ""] ?: 3
        val items = mutableListOf<SpaceAlertItem>()
        fun walk(s: AgentSessionRow, depth: Int) {
            items.add(SpaceAlertItem(
                "session", s.id, s.name.removeSuffix(" (fork)"),
                levelOf(s)?.takeIf { !suppressed(s) } ?: "context",
                depth = depth,
                fork = s.parentClaudeSessionId != null,
            ))
            for (c in (childrenOf[s.claudeSessionId] ?: emptyList()).sortedBy { sortKey(it) }) {
                if (c.id != s.id) walk(c, depth + 1)
            }
        }
        for (root in (childrenOf[null] ?: emptyList()).sortedBy { sortKey(it) }) walk(root, 0)
        if (kind == "project") {
            for (f in notesFiles) {
                if (!f.dirty) continue
                val inSpace = f.path.startsWith("projects/$slug/") || f.path == "projects/$slug.md"
                if (inSpace) items.add(SpaceAlertItem("file", f.path, f.path.substringAfterLast('/'), "dirty"))
            }
        }
        return items
    }

    fun itemsFor(sp: SpacesRepository.SpaceSummary) = alertItems(sp.slug, sp.kind, sp.cardAgentKeys.toSet())
    val areas = spaces.filter { it.kind == "area" }
        .sortedWith(compareBy<SpacesRepository.SpaceSummary> { itemsFor(it).none { a -> a.level != "context" } }.thenBy { it.title.lowercase() })
    val projects = spaces.filter { it.kind == "project" }
        .sortedWith(compareBy<SpacesRepository.SpaceSummary> { itemsFor(it).none { a -> a.level != "context" } }
            .thenBy { it.status == "dormant" || it.status == "complete" }
            .thenBy { it.title.lowercase() })

    var showFleet by remember { mutableStateOf(false) }
    val fallback by agents.fallbackNotice.collectAsState()
    val handoff by agents.handoff.collectAsState()

    Column(Modifier.fillMaxSize()) {
        io.amar.console.ui.components.PaneTopBar(
            title = "Spaces", onGrid = onGrid,
            subtitle = "${projects.size} projects · ${areas.size} areas",
            actions = {
                IconButton(onClick = { showFleet = true }) {
                    Icon(androidx.compose.material.icons.Icons.Filled.Tune, contentDescription = "Fleet model", modifier = Modifier.size(20.dp))
                }
            },
        )
        // Model-fallback banner (fleet-level, was on the Agents tab).
        fallback?.let { fb ->
            Row(
                Modifier.fillMaxWidth().background(AMBER.copy(alpha = 0.15f)).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "${fb.failedModel} was unavailable — agents fell back to ${fb.model}",
                    style = MaterialTheme.typography.labelSmall, color = AMBER, modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { agents.dismissFallbackNotice() }) { Text("Dismiss", color = AMBER) }
            }
        }
        // Al hand-off offer ("Talk to X") — target resolved by live agentKey.
        handoff?.let { h ->
            Row(
                Modifier.fillMaxWidth().background(VIOLET.copy(alpha = 0.1f)).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val target = sessions.firstOrNull { it.agentKey == h.targetAgentKey && it.status != "ended" }
                Text(
                    "Al suggests you talk to ${target?.name?.removeSuffix(" (fork)") ?: h.targetAgentKey}",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f),
                )
                TextButton(onClick = {
                    target?.let { onOpenSession(it.id) }
                    agents.clearHandoff()
                }) { Text("Talk →") }
                TextButton(onClick = { agents.dismissHandoff() }) { Text("✕") }
            }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            fun renderSpace(scope: androidx.compose.foundation.lazy.LazyListScope, sp: SpacesRepository.SpaceSummary) {
                val items = itemsFor(sp)
                scope.item(key = "${sp.kind}:${sp.slug}") {
                    val boundHere = spaceSessions(sp.slug, sp.kind)
                    // A plain-unread session whose @key owns an Under-Review card
                    // is a review hand-back: its blue moves Bot → kanban badge.
                    val reviewOwners = sp.reviewAgentKeys.toSet()
                    fun isHandback(s: AgentSessionRow) =
                        s.hasUnread && !s.needsAttention && s.agentKey != null && s.agentKey in reviewOwners
                    SpaceRow(
                        sp, hasAlerts = items.isNotEmpty(),
                        boundCount = boundHere.count { !isHandback(it) },
                        boundAttention = boundHere.any { it.needsAttention },
                        boundUnread = boundHere.any { it.hasUnread && !isHandback(it) },
                        reviewUnread = boundHere.any { isHandback(it) },
                        onClick = { onOpenSpace("${sp.kind}/${sp.slug}") },
                    )
                }
                scope.items(items, key = { "${sp.kind}:${sp.slug}:${it.kind}:${it.id}" }) { a ->
                    AlertRow(a, onClick = {
                        if (a.kind == "session") onOpenSession(a.id) else onOpenNote(a.id)
                    })
                }
            }
            if (areas.isNotEmpty()) {
                item { SectionHeader("AREAS") }
                for (sp in areas) renderSpace(this, sp)
            }
            item { SectionHeader("PROJECTS") }
            for (sp in projects) renderSpace(this, sp)
        }
    }
    if (showFleet) io.amar.console.ui.agents.FleetModelSheet(agents, onDismiss = { showFleet = false })
}

/** Fork-lineage depth (parentClaudeSessionId chain within the live set, cap 6)
 *  — indents alert rows + the space Agents list like the SPA rails. */
fun forkDepth(session: AgentSessionRow, all: List<AgentSessionRow>): Int {
    val byCsid = all.filter { it.claudeSessionId != null }.associateBy { it.claudeSessionId!! }
    var d = 0
    var cur: AgentSessionRow? = session
    while (cur?.parentClaudeSessionId != null && d < 6) {
        cur = byCsid[cur.parentClaudeSessionId!!] ?: break
        d++
    }
    return d
}

/** Sessions bound to a space: session project/areas fields (SPA parity —
 *  the binding lives on the session since durable roles were removed). */
fun sessionsForSpace(
    slug: String,
    kind: String,
    sessions: List<AgentSessionRow>,
): List<AgentSessionRow> = sessions.filter { s ->
    s.status != "ended" && !s.isAl &&
        (if (kind == "project") s.project == slug else slug in s.areaList())
}

/** Flattened fork-lineage order: roots first, each followed by its forks
 *  (DFS over parentClaudeSessionId restricted to the bound set), with depths. */
fun lineageOrder(
    bound: List<AgentSessionRow>,
): List<Pair<AgentSessionRow, Int>> {
    // Children keyed by the PARENT's session id (SPA parity) — NEVER by
    // agentKey: a chat fork has agentKey null, so a null-key child's walk
    // looked up childrenOf[null] = the ROOTS bucket → root → fork → root …
    // infinite recursion → StackOverflowError (the "Agents tab crashes the
    // app" bug, ^tall-bear). Duplicate agentKeys had the same failure shape.
    val byCsid = bound.filter { it.claudeSessionId != null }.associateBy { it.claudeSessionId!! }
    val childrenOf = bound.groupBy { s ->
        s.parentClaudeSessionId?.let { byCsid[it]?.id }
    }
    val out = mutableListOf<Pair<AgentSessionRow, Int>>()
    val seen = mutableSetOf<String>()
    // Creation order, not alphabetical — the SPA rail preserves the hub's
    // list order (manifest = creation), so the space's long-lived general
    // agent leads and recent ticket-forks trail, nested under their parent.
    fun walk(s: AgentSessionRow, depth: Int) {
        if (!seen.add(s.id)) return
        out.add(s to depth)
        for (child in (childrenOf[s.id] ?: emptyList()).sortedBy { it.createdAt }) walk(child, depth + 1)
    }
    for (root in (childrenOf[null] ?: emptyList()).sortedBy { it.createdAt }) walk(root, 0)
    // Anything unreached (cycle edge) still renders, flat.
    for (s in bound) if (seen.add(s.id)) out.add(s to 0)
    return out
}

@Composable
private fun SectionHeader(label: String) {
    Text(
        label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 2.dp),
    )
}

/** A concrete alert item under a space: an unread/alerted session or a
 *  dirty file — SPA SpaceAlert parity, rendered as a tappable row. */
data class SpaceAlertItem(
    val kind: String, val id: String, val label: String, val level: String,
    /** Fork-lineage indent depth (sessions only). */
    val depth: Int = 0,
    val fork: Boolean = false,
)

@Composable
private fun SpaceRow(
    sp: SpacesRepository.SpaceSummary,
    hasAlerts: Boolean,
    boundCount: Int = 0,
    boundAttention: Boolean = false,
    boundUnread: Boolean = false,
    /** An unread bot's unread is really a review hand-back it owns — the blue
     *  belongs on the kanban badge, not the Bot badge (SPA parity). */
    reviewUnread: Boolean = false,
    onClick: () -> Unit,
) {
    val dim = sp.status == "dormant" || sp.status == "complete"
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            if (sp.kind == "area") Icons.Filled.Tag else Icons.Filled.Folder,
            contentDescription = null,
            tint = if (dim) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f) else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(
                sp.title, style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (hasAlerts) FontWeight.SemiBold else FontWeight.Normal,
                color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            val meta = listOfNotNull(
                sp.status,
                if (sp.fileCount > 0) "${sp.fileCount} files" else null,
            ).joinToString(" · ")
            if (meta.isNotEmpty()) {
                Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // SPA rail-1 parity: Bot+count coloured by the space's hottest alert
        // (red attention > blue unread > grey), Kanban glyph when a board exists.
        if (boundCount > 0) {
            val botTint = when {
                boundAttention -> MaterialTheme.colorScheme.error
                boundUnread -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            }
            Icon(Icons.Filled.SmartToy, "$boundCount agents", tint = botTint, modifier = Modifier.size(13.dp))
            Text("$boundCount", style = MaterialTheme.typography.labelSmall, color = botTint)
        }
        if (sp.boardPath != null) {
            val kanbanTint =
                if (reviewUnread) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
            Icon(
                Icons.Filled.ViewKanban,
                contentDescription = if (sp.reviewCount > 0) "${sp.reviewCount} under review" else "Has a board",
                tint = kanbanTint,
                modifier = Modifier.size(14.dp),
            )
            if (sp.reviewCount > 0) {
                Text("${sp.reviewCount}", style = MaterialTheme.typography.labelSmall, color = kanbanTint)
            }
        }
    }
}

@Composable
private fun Dot(color: Color) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

/** Inline alert row under a space (indented): dot colour = level, label =
 *  the session/file name; tap goes STRAIGHT to it (SPA openAlert parity). */
@Composable
private fun AlertRow(a: SpaceAlertItem, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .padding(start = (42 + a.depth * 14).dp, end = 16.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when (a.level) {
            "attention" -> Dot(MaterialTheme.colorScheme.error)
            "working" -> androidx.compose.material3.CircularProgressIndicator(Modifier.size(9.dp), strokeWidth = 1.5.dp, color = AMBER)
            "unread" -> Dot(MaterialTheme.colorScheme.primary)
            // Non-alerted ancestor pulled in for tree shape — neutral marker.
            "context" -> Dot(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.25f))
            else -> Text("✎", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (a.fork) {
            Icon(
                Icons.AutoMirrored.Filled.CallSplit,
                contentDescription = "Fork", tint = VIOLET, modifier = Modifier.size(11.dp),
            )
        }
        Text(
            a.label, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

// ------------------------------------------------------------------------- //
// L2 — space detail: Board | Agents | Docs
// ------------------------------------------------------------------------- //

@Composable
fun SpaceDetailScreen(
    spacesRepo: SpacesRepository,
    agents: AgentsRepository,
    notes: io.amar.console.data.notes.NotesRepository,
    kind: String,
    slug: String,
    onBack: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenNote: (String) -> Unit,
) {
    val spaces by spacesRepo.spaces.collectAsState()
    val sp = spaces.firstOrNull { it.slug == slug && it.kind == kind }
    val sessions by agents.observeSessions().collectAsState(initial = emptyList())
    val bound = remember(sessions) { sessionsForSpace(slug, kind, sessions) }
    val scope = rememberCoroutineScope()

    // Default tab priority: board above all else when it exists; otherwise
    // whichever has signal — unreads/attention pull Agents forward; Docs only
    // when there is nothing agent-shaped to look at.
    val activityMap by agents.activity.collectAsState()
    var tab by remember(slug) {
        val hasSignal = bound.any { it.hasUnread || it.needsAttention || activityMap[it.id]?.running == true }
        mutableStateOf(
            when {
                sp?.boardPath != null -> "board"
                hasSignal || bound.isNotEmpty() || kind == "area" -> "agents"
                else -> "docs"
            }
        )
    }
    LaunchedEffect(slug) {
        spacesRepo.refreshSpaces()
        if (sp?.boardPath != null) spacesRepo.loadBoard(slug) else spacesRepo.clearBoard()
    }
    LaunchedEffect(sp?.boardPath) { if (sp?.boardPath != null) spacesRepo.loadBoard(slug) }

    Column(Modifier.fillMaxSize()) {
        io.amar.console.ui.components.PaneTopBar(
            title = sp?.title ?: slug,
            subtitle = listOfNotNull(sp?.status, if (bound.isNotEmpty()) "${bound.size} agents" else null)
                .joinToString(" · ").ifEmpty { null },
            onBack = onBack,
        )
        // Segmented tabs.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val tabs = buildList {
                if (sp?.boardPath != null) add("board" to "Board")
                else if (kind == "project") add("newboard" to "+ Board")
                add("agents" to "Agents")
                if (kind == "project") add("docs" to "Docs")
            }
            for ((id, label) in tabs) {
                Surface(
                    onClick = { tab = id },
                    shape = RoundedCornerShape(8.dp),
                    color = if (tab == id) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp))
                }
            }
        }
        when (tab) {
            "newboard" -> {
                val nbScope = rememberCoroutineScope()
                TextButton(
                    onClick = { nbScope.launch { if (spacesRepo.createBoard(slug)) tab = "board" } },
                    modifier = Modifier.padding(16.dp),
                ) { Text("Create a kanban board for this project") }
            }
            "board" -> BoardView(spacesRepo, sessions, bound, kind, slug, onOpenSession)
            "agents" -> SpaceAgentsList(agents, sessions, bound, kind, slug, onOpenSession)
            "docs" -> SpaceDocsList(notes, slug, onOpenNote)
        }
    }
}

// ------------------------------------------------------------------------- //
// Board — horizontally paged columns, Done hidden (stays in file)
// ------------------------------------------------------------------------- //

@Composable
private fun BoardView(
    spacesRepo: SpacesRepository,
    allSessions: List<AgentSessionRow>,
    bound: List<AgentSessionRow>,
    kind: String,
    slug: String,
    onOpenSession: (String) -> Unit,
) {
    val loaded by spacesRepo.board.collectAsState()
    val error by spacesRepo.boardError.collectAsState()
    val scope = rememberCoroutineScope()
    var sheetCard by remember { mutableStateOf<SpacesRepository.CardView?>(null) }
    var addToColumn by remember { mutableStateOf<String?>(null) }
    val board = loaded ?: run {
        Text(
            error ?: "Loading board…",
            style = MaterialTheme.typography.labelSmall,
            color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(16.dp),
        )
        return
    }
    // Done columns stay in the FILE but hide on screen (SPA parity). Moving
    // TO Done stays available in the card sheet — this app is Yousef's
    // device and he alone approves.
    val visibleCols = board.columns.filter { !KanbanCodec.DONE_COLUMN_RE.matches(it.title) }
    val doneCount = board.columns.filter { KanbanCodec.DONE_COLUMN_RE.matches(it.title) }.sumOf { it.cards.size }

    Column(Modifier.fillMaxSize()) {
        // Sticky dismissible mutation-error banner — never a board takeover
        // (the board itself stays interactive underneath).
        error?.let { err ->
            Row(
                Modifier.fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 3.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.errorContainer)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    err, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Icon(
                    Icons.Filled.Close, contentDescription = "Dismiss",
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.size(14.dp).clickable { spacesRepo.clearError() },
                )
            }
        }
        LazyRow(
            Modifier.fillMaxSize().padding(top = 4.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(visibleCols, key = { it.title }) { col ->
                Column(
                    Modifier.width(290.dp).fillMaxSize()
                        .clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                        .padding(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(col.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                        Text("${col.cards.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        IconButton(onClick = { addToColumn = col.title }, modifier = Modifier.size(26.dp)) {
                            Icon(Icons.Filled.Add, "Add card", modifier = Modifier.size(16.dp))
                        }
                    }
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxSize()) {
                        items(col.cards.size) { i ->
                            val card = col.cards[i]
                            SwipeToDone(
                                onDone = { scope.launch { spacesRepo.moveCard(slug, card, "Done") } },
                            ) { CardChip(card, allSessions) { sheetCard = card } }
                        }
                        if (doneCount > 0 && col === visibleCols.last()) {
                            item {
                                Text(
                                    "$doneCount done (hidden)", style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                    modifier = Modifier.padding(top = 8.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    sheetCard?.let { card ->
        CardSheet(
            spacesRepo = spacesRepo,
            card = card,
            allSessions = allSessions,
            bound = bound,
            kind = kind,
            slug = slug,
            columns = board.columns.map { it.title },
            onOpenSession = onOpenSession,
            onDismiss = { sheetCard = null },
        )
    }
    addToColumn?.let { colTitle ->
        AddCardSheet(
            column = colTitle,
            onAdd = { text, done ->
                scope.launch {
                    // addCard already retries once; on final failure the
                    // sheet STAYS OPEN with the typed text intact — a
                    // transient hub error must not eat a dictated card.
                    val ok = spacesRepo.addCard(slug, text, colTitle)
                    if (ok) addToColumn = null
                    done(ok)
                }
            },
            onDismiss = { addToColumn = null },
        )
    }
}

@Composable
private fun CardChip(
    card: SpacesRepository.CardView,
    allSessions: List<AgentSessionRow>,
    onClick: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        val tagSplit = remember(card.text) { io.amar.console.data.spaces.CardContent.splitTrailingTags(card.text) }
        val images = remember(card.detail) { io.amar.console.data.spaces.CardContent.imagePaths(card.detail) }
        val textDetail = remember(card.detail) { io.amar.console.data.spaces.CardContent.textDetail(card.detail) }
        val urls = remember(card.text, card.detail) { io.amar.console.data.spaces.CardContent.cardUrls(card.text, card.detail) }
        Text(
            tagSplit.text,
            style = MaterialTheme.typography.bodySmall,
            color = if (card.checked) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
        // Detail preview (image lines stripped), newline-preserved, clamped.
        if (textDetail.isNotEmpty()) {
            Text(
                textDetail.joinToString("\n"),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 4, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        // Image thumbs (48dp) via GET /notes/asset/<path> (bearer via Coil).
        if (images.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 3.dp)) {
                for (path in images.take(4)) {
                    coil.compose.AsyncImage(
                        model = io.amar.console.core.HubConfig.hubBase + "/notes/asset/" + java.net.URLEncoder.encode(path, "UTF-8"),
                        contentDescription = null,
                        modifier = Modifier.size(48.dp).clip(RoundedCornerShape(6.dp)),
                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    )
                }
            }
        }
        // URL chips — tappable, open browser.
        if (urls.isNotEmpty()) {
            val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(top = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (u in urls.take(6)) {
                    Surface(
                        onClick = { runCatching { uriHandler.openUri(u.url) } },
                        shape = RoundedCornerShape(6.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Row(Modifier.padding(horizontal = 6.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            Icon(Icons.Filled.Link, null, tint = Color(0xFF60A5FA), modifier = Modifier.size(10.dp))
                            Text(u.label, style = MaterialTheme.typography.labelSmall, color = Color(0xFF60A5FA), maxLines = 1)
                        }
                    }
                }
            }
        }
        // Generic tag badges (blocked/nofork/model have dedicated ones below).
        if (tagSplit.tags.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 3.dp)) {
                for (tag in tagSplit.tags.take(5)) {
                    Surface(shape = RoundedCornerShape(5.dp), color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.6f)) {
                        Text(tag, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp))
                    }
                }
            }
        }
        val hasMeta = card.blocked || card.agentKey != null || card.blockId != null
        if (hasMeta) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                if (card.blocked) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        Icon(Icons.Filled.Block, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(11.dp))
                        Text("blocked", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                }
                card.agentKey?.let { key ->
                    val label = io.amar.console.data.spaces.agentLabel(key, allSessions)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        Icon(Icons.Filled.SmartToy, null, tint = VIOLET, modifier = Modifier.size(11.dp))
                        Text(label, style = MaterialTheme.typography.labelSmall, color = VIOLET, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (card.blockId != null) {
                    Text("dispatched", style = MaterialTheme.typography.labelSmall, color = GREEN)
                }
            }
        }
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun CardSheet(
    spacesRepo: SpacesRepository,
    card: SpacesRepository.CardView,
    allSessions: List<AgentSessionRow>,
    bound: List<AgentSessionRow>,
    kind: String,
    slug: String,
    columns: List<String>,
    onOpenSession: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    fun run(block: suspend () -> Unit) { scope.launch { block(); onDismiss() } }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        // The whole sheet scrolls — a long card detail (agent report notes)
        // must never push Move/Assign/Open-agent out of reach.
        Column(Modifier.padding(horizontal = 20.dp).verticalScroll(rememberScrollState())) {
            val sheetTags = remember(card.text) { io.amar.console.data.spaces.CardContent.splitTrailingTags(card.text) }
            val sheetImages = remember(card.detail) { io.amar.console.data.spaces.CardContent.imagePaths(card.detail) }
            val sheetTextDetail = remember(card.detail) { io.amar.console.data.spaces.CardContent.textDetail(card.detail) }
            val sheetUrls = remember(card.text, card.detail) { io.amar.console.data.spaces.CardContent.cardUrls(card.text, card.detail) }
            Text(sheetTags.text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            if (sheetTags.tags.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                    for (tag in sheetTags.tags) {
                        Surface(shape = RoundedCornerShape(5.dp), color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.6f)) {
                            Text(tag, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp))
                        }
                    }
                }
            }
            if (sheetTextDetail.isNotEmpty()) {
                var detailExpanded by remember { mutableStateOf(false) }
                Text(
                    sheetTextDetail.joinToString("\n"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (detailExpanded) Int.MAX_VALUE else 8,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 4.dp).clickable { detailExpanded = !detailExpanded },
                )
                if (!detailExpanded && sheetTextDetail.size > 8) {
                    Text(
                        "… show all", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable { detailExpanded = true }.padding(vertical = 2.dp),
                    )
                }
            }
            if (sheetImages.isNotEmpty()) {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (path in sheetImages) {
                        coil.compose.AsyncImage(
                            model = io.amar.console.core.HubConfig.hubBase + "/notes/asset/" + java.net.URLEncoder.encode(path, "UTF-8"),
                            contentDescription = path,
                            modifier = Modifier.size(96.dp).clip(RoundedCornerShape(8.dp)),
                            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                        )
                    }
                }
            }
            if (sheetUrls.isNotEmpty()) {
                val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
                Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    for (u in sheetUrls) {
                        Row(
                            Modifier.clickable { runCatching { uriHandler.openUri(u.url) } },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(Icons.Filled.Link, null, tint = Color(0xFF60A5FA), modifier = Modifier.size(12.dp))
                            Text(u.label, style = MaterialTheme.typography.labelMedium, color = Color(0xFF60A5FA), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 6.dp)) {
                Text("in ${card.column}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                card.agentKey?.let { key ->
                    Text("→ ${io.amar.console.data.spaces.agentLabel(key, allSessions)}", style = MaterialTheme.typography.labelSmall, color = VIOLET, maxLines = 1)
                }
                if (card.blockId != null) Text("dispatched ^${card.blockId}", style = MaterialTheme.typography.labelSmall, color = GREEN)
                if (card.blocked) Text("#blocked", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }

            Text("Move to", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (colTitle in columns.filter { it != card.column }) {
                    Surface(
                        onClick = { run { spacesRepo.moveCard(slug, card, colTitle) } },
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Text(colTitle, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }

            // Assignment is the delegation trigger once in an In-Progress
            // column (hub stamps + forks + wakes). Space-bound sessions first,
            // the rest of the live fleet dimmed after. Per-ticket forks are
            // the DISPATCH result, not assign targets (SPA PillPicker parity).
            Text("Assign to", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
            val boundKeys = bound.mapNotNull { it.agentKey }.toSet()
            val assignable = allSessions
                .filter { it.status != "ended" && !it.isAl && it.agentKey != null && it.parentClaudeSessionId == null }
                .distinctBy { it.agentKey }
                .sortedWith(compareBy({ it.agentKey !in boundKeys }, { it.name.lowercase() }))
                .take(24)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (sess in assignable) {
                    val selected = card.agentKey == sess.agentKey
                    val inSpace = sess.agentKey in boundKeys
                    Surface(
                        onClick = { run { spacesRepo.assignCard(slug, card, if (selected) null else sess.agentKey) } },
                        shape = RoundedCornerShape(8.dp),
                        color = when {
                            selected -> MaterialTheme.colorScheme.secondaryContainer
                            inSpace -> MaterialTheme.colorScheme.surfaceVariant
                            else -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
                        },
                    ) {
                        Text(
                            sess.name.removeSuffix(" (fork)"),
                            style = MaterialTheme.typography.labelMedium,
                            color = if (inSpace || selected) MaterialTheme.colorScheme.onSurface
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }

            var editing by remember { mutableStateOf(false) }
            if (editing) {
                // Line 1 = card text, rest = detail (SPA card editor shape).
                var editText by remember { mutableStateOf((listOf(card.text) + card.detail).joinToString("\n")) }
                DictatedTextField(
                    value = editText, onValueChange = { editText = it },
                    placeholder = "Card text\ndetail lines…",
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    TextButton(onClick = {
                        val lines = editText.trim().lines()
                        if (lines.isNotEmpty() && lines[0].isNotBlank()) {
                            run { spacesRepo.editCard(slug, card, lines[0].trim(), lines.drop(1)) }
                        }
                    }) { Text("Save") }
                    TextButton(onClick = { editing = false }) { Text("Cancel") }
                }
            }
            Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (!editing) TextButton(onClick = { editing = true }) { Text("Edit") }
                TextButton(onClick = { run { spacesRepo.setBlocked(slug, card, !card.blocked) } }) {
                    Text(if (card.blocked) "Unblock" else "Mark #blocked")
                }
                card.agentKey?.let { key ->
                    bound.firstOrNull { it.agentKey == key }?.let { sess ->
                        TextButton(onClick = { onDismiss(); onOpenSession(sess.id) }) { Text("Open agent") }
                    }
                }
                TextButton(onClick = { run { spacesRepo.removeCard(slug, card) } }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}

/** OutlinedTextField + mic trailing icon (icon-only, no hint text — SPA card
 *  editor parity). Live transcript renders appended while dictating; stop
 *  folds the committed text into the value. */
@Composable
private fun DictatedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val dictation by io.amar.console.core.Dictation.state.collectAsState()
    val display = if (dictation.active && dictation.transcript.isNotEmpty())
        (value.trimEnd() + " " + dictation.transcript).trim() else value
    val micPermission = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) io.amar.console.core.Dictation.start() }
    androidx.compose.material3.OutlinedTextField(
        value = display,
        onValueChange = {
            if (dictation.active) io.amar.console.core.Dictation.cancel()
            onValueChange(it)
        },
        placeholder = { Text(placeholder) },
        enabled = enabled,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
            capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
        ),
        trailingIcon = {
            IconButton(onClick = {
                if (dictation.active) {
                    io.amar.console.core.Dictation.stop { committed ->
                        if (committed.isNotBlank()) onValueChange((value.trimEnd() + " " + committed).trim())
                    }
                } else {
                    val granted = ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                    if (granted) io.amar.console.core.Dictation.start()
                    else micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                }
            }) {
                Icon(
                    if (dictation.active) Icons.Filled.Stop
                    else Icons.Filled.Mic,
                    contentDescription = if (dictation.active) "Stop dictation" else "Dictate",
                    tint = if (dictation.active) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
        },
        modifier = modifier,
    )
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun AddCardSheet(column: String, onAdd: (String, (Boolean) -> Unit) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Text("New card in $column", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            DictatedTextField(
                value = text, onValueChange = { text = it; failed = false },
                placeholder = "Card text",
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            )
            if (failed) {
                // Add failed twice — the typed text is preserved above; a
                // transient hub error must never eat a dictated card.
                Text(
                    "Couldn't add the card — your text is kept, try again.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            TextButton(
                onClick = {
                    if (text.isNotBlank() && !busy) {
                        busy = true; failed = false
                        onAdd(text.trim()) { ok -> busy = false; failed = !ok }
                    }
                },
                enabled = text.isNotBlank() && !busy,
            ) { Text(if (busy) "Adding…" else if (failed) "Retry" else "Add") }
            Spacer(Modifier.size(24.dp))
        }
    }
}

/** Swipe-right = mark Done — the mobile analogue of the SPA's drag-to-Done
 *  mini track (^aka55s): the Done column is hidden from the pager, so this is
 *  the quick approval gesture. Drag past the threshold fires ONCE; a green
 *  check reveals behind the card as it slides. */
@Composable
private fun SwipeToDone(onDone: () -> Unit, content: @Composable () -> Unit) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val maxDragPx = with(density) { 96.dp.toPx() }
    val triggerPx = with(density) { 72.dp.toPx() }
    val offsetX = remember { androidx.compose.animation.core.Animatable(0f) }
    val scope = rememberCoroutineScope()
    var fired by remember { mutableStateOf(false) }
    Box {
        if (offsetX.value > 8f) {
            Icon(
                Icons.Filled.Check, contentDescription = "Mark Done",
                tint = GREEN.copy(alpha = (offsetX.value / triggerPx).coerceIn(0f, 1f)),
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 14.dp).size(18.dp),
            )
        }
        Box(
            Modifier
                .offset { androidx.compose.ui.unit.IntOffset(offsetX.value.toInt(), 0) }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            if (offsetX.value >= triggerPx && !fired) { fired = true; onDone() }
                            scope.launch {
                                offsetX.animateTo(0f, androidx.compose.animation.core.tween(180))
                                fired = false
                            }
                        },
                    ) { _, dragAmount ->
                        val next = (offsetX.value + dragAmount).coerceIn(0f, maxDragPx)
                        scope.launch { offsetX.snapTo(next) }
                    }
                },
        ) { content() }
    }
}

// ------------------------------------------------------------------------- //
// Agents + Docs tabs
// ------------------------------------------------------------------------- //

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SpaceAgentsList(
    agents: AgentsRepository,
    allSessions: List<AgentSessionRow>,
    bound: List<AgentSessionRow>,
    kind: String,
    slug: String,
    onOpenSession: (String) -> Unit,
) {
    val activity by agents.activity.collectAsState()
    val todosMap by agents.todos.collectAsState()
    var creating by remember { mutableStateOf(false) }
    // Fork-lineage order: parents before their forks, indented by depth
    // (parentClaudeSessionId — SPA SpaceRail tree parity, flattened).
    val ordered = remember(bound) { lineageOrder(bound) }
    var menuTarget by remember { mutableStateOf<AgentSessionRow?>(null) }
    val micOwner by io.amar.console.data.agents.Mic.owner.collectAsState()
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f)) {
            items(ordered, key = { it.first.id }) { (s, depth) ->
                Row(
                    Modifier.fillMaxWidth()
                        .combinedClickable(onClick = { onOpenSession(s.id) }, onLongClick = { menuTarget = s })
                        .padding(start = (16 + depth * 14).dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    when {
                        activity[s.id]?.running == true ->
                            androidx.compose.material3.CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                        s.needsAttention -> Dot(MaterialTheme.colorScheme.error)
                        s.hasUnread -> Dot(MaterialTheme.colorScheme.primary)
                        else -> Spacer(Modifier.size(8.dp))
                    }
                    if (s.parentClaudeSessionId != null) {
                        Icon(
                            Icons.AutoMirrored.Filled.CallSplit,
                            contentDescription = "Fork", tint = VIOLET, modifier = Modifier.size(12.dp),
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(s.name.removeSuffix(" (fork)"), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(s.status + if (s.hibernated) " · hibernated" else "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    // SPA SessionBadges parity: amber shell count, violet todo
                    // progress (hidden once complete), mic owner, dormant moon.
                    if (s.backgroundProcessCount > 0) {
                        Icon(Icons.Filled.Terminal, "Background processes", tint = AMBER, modifier = Modifier.size(13.dp))
                        Text("${s.backgroundProcessCount}", style = MaterialTheme.typography.labelSmall, color = AMBER)
                    }
                    todosMap[s.id]?.let { ts ->
                        val done = ts.count { it.status == "completed" }
                        if (ts.isNotEmpty() && done < ts.size) {
                            Text("$done/${ts.size}", style = MaterialTheme.typography.labelSmall, color = VIOLET)
                        }
                    }
                    if (micOwner == s.id) {
                        Icon(Icons.Filled.Mic, "Owns the mic", tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(13.dp))
                    }
                    if (s.hibernated) {
                        Icon(Icons.Filled.Bedtime, "Dormant", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(13.dp))
                    }
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                }
            }
            if (bound.isEmpty()) {
                item {
                    Text(
                        "No agents bound to this space yet.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
        TextButton(onClick = { creating = true }, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
            Icon(Icons.Filled.Add, null, modifier = Modifier.size(14.dp)); Spacer(Modifier.size(4.dp)); Text("New agent in this space")
        }
    }
    menuTarget?.let { target ->
        io.amar.console.ui.agents.SessionActionsSheet(
            session = target,
            micOwner = micOwner == target.id,
            onDismiss = { menuTarget = null },
            onRename = { newName -> agents.renameSession(target.id, newName) },
            onKill = { agents.killSession(target.id) },
            onMarkUnread = { agents.markUnread(target.id) },
            onMarkRead = { agents.markRead(target.id) },
            onGenerateTitle = { agents.generateTitle(target.id) },
            onReloadHistory = { agents.reloadSessionHistory(target.id) },
            onFork = { agents.forkSession(target.id, target.cwd) },
            onMerge = { agents.mergeSession(target.id) },
            onMic = { io.amar.console.data.agents.Mic.setMic(if (micOwner == target.id) "al" else target.id) },
            onShowInfo = null,
        )
    }
    if (creating) {
        NewSpaceAgentSheet(
            onCreate = { prompt, cwd ->
                creating = false
                // Mints a durable role WITH the space binding (SPA + button parity).
                agents.createSession(
                    prompt = prompt, cwd = cwd, asAgent = true,
                    project = if (kind == "project") slug else null,
                    areas = if (kind == "area") listOf(slug) else emptyList(),
                )
            },
            onDismiss = { creating = false },
        )
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun NewSpaceAgentSheet(onCreate: (prompt: String, cwd: String) -> Unit, onDismiss: () -> Unit) {
    var prompt by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("/home/amar") }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Text("New agent in this space", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            androidx.compose.material3.OutlinedTextField(
                value = prompt, onValueChange = { prompt = it },
                placeholder = { Text("Charter / first prompt") },
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            )
            androidx.compose.material3.OutlinedTextField(
                value = cwd, onValueChange = { cwd = it },
                label = { Text("cwd") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            )
            TextButton(onClick = { if (prompt.isNotBlank()) onCreate(prompt.trim(), cwd.trim()) }, enabled = prompt.isNotBlank()) { Text("Create") }
            Spacer(Modifier.size(24.dp))
        }
    }
}

@Composable
private fun SpaceDocsList(
    notes: io.amar.console.data.notes.NotesRepository,
    slug: String,
    onOpenNote: (String) -> Unit,
) {
    val files by notes.observeFiles().collectAsState(initial = emptyList())
    val scoped = remember(files, slug) {
        files.filter { it.path.startsWith("projects/$slug/") || it.path == "projects/$slug.md" }
            .sortedBy { it.path }
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(scoped, key = { it.path }) { f ->
            Row(
                Modifier.fillMaxWidth().clickable { onOpenNote(f.path) }.padding(horizontal = 16.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    f.path.removePrefix("projects/$slug/").removePrefix("projects/"),
                    style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (scoped.isEmpty()) {
            item {
                Text("No files.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
        }
    }
}
