package io.amar.console.ui.spaces

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Mic
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
    fun alertItems(slug: String, kind: String): List<SpaceAlertItem> {
        val items = mutableListOf<SpaceAlertItem>()
        for (s in spaceSessions(slug, kind)) {
            val level = when {
                s.needsAttention -> "attention"
                activity[s.id]?.running == true -> "working"
                s.hasUnread -> "unread"
                else -> continue
            }
            items.add(SpaceAlertItem(
                "session", s.id, s.name.removeSuffix(" (fork)"), level,
                depth = forkDepth(s, sessions),
                fork = s.parentClaudeSessionId != null,
            ))
        }
        if (kind == "project") {
            for (f in notesFiles) {
                if (!f.dirty) continue
                val inSpace = f.path.startsWith("projects/$slug/") || f.path == "projects/$slug.md"
                if (inSpace) items.add(SpaceAlertItem("file", f.path, f.path.substringAfterLast('/'), "dirty"))
            }
        }
        val rank = mapOf("attention" to 0, "working" to 1, "unread" to 2, "dirty" to 3)
        return items.sortedBy { rank[it.level] ?: 4 }
    }

    val areas = spaces.filter { it.kind == "area" }
        .sortedWith(compareBy<SpacesRepository.SpaceSummary> { alertItems(it.slug, it.kind).isEmpty() }.thenBy { it.title.lowercase() })
    val projects = spaces.filter { it.kind == "project" }
        .sortedWith(compareBy<SpacesRepository.SpaceSummary> { alertItems(it.slug, it.kind).isEmpty() }
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
                val items = alertItems(sp.slug, sp.kind)
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
        error?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
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
                            CardChip(col.cards[i], allSessions) { sheetCard = col.cards[i] }
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
            onAdd = { text ->
                addToColumn = null
                scope.launch { spacesRepo.addCard(slug, text, colTitle) }
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
        Text(
            card.text,
            style = MaterialTheme.typography.bodySmall,
            color = if (card.checked) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
        // Detail preview, newline-preserved, clamped (SPA 6-line clamp).
        if (card.detail.isNotEmpty()) {
            Text(
                card.detail.joinToString("\n"),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 4, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
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
                    val label = (allSessions.firstOrNull { it.agentKey == key }?.name ?: key).removeSuffix(" (fork)")
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
            Text(card.text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            if (card.detail.isNotEmpty()) {
                var detailExpanded by remember { mutableStateOf(false) }
                Text(
                    card.detail.joinToString("\n"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (detailExpanded) Int.MAX_VALUE else 8,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 4.dp).clickable { detailExpanded = !detailExpanded },
                )
                if (!detailExpanded && card.detail.joinToString("\n").lines().size > 8) {
                    Text(
                        "… show all", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable { detailExpanded = true }.padding(vertical = 2.dp),
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 6.dp)) {
                Text("in ${card.column}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                card.agentKey?.let { key ->
                    val t = allSessions.firstOrNull { it.agentKey == key }?.name ?: key
                    Text("→ ${t.removeSuffix(" (fork)")}", style = MaterialTheme.typography.labelSmall, color = VIOLET, maxLines = 1)
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

            Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
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

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun AddCardSheet(column: String, onAdd: (String) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Text("New card in $column", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            androidx.compose.material3.OutlinedTextField(
                value = text, onValueChange = { text = it },
                placeholder = { Text("Card text") },
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            )
            TextButton(onClick = { if (text.isNotBlank()) onAdd(text.trim()) }, enabled = text.isNotBlank()) { Text("Add") }
            Spacer(Modifier.size(24.dp))
        }
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
