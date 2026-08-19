package io.amar.console.ui.spaces

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Tag
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
import io.amar.console.data.spaces.CardRef
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
    onGrid: () -> Unit = {},
) {
    val spaces by spacesRepo.spaces.collectAsState()
    val roles by agents.roles.collectAsState()
    val sessions by agents.observeSessions().collectAsState(initial = emptyList())
    val activity by agents.activity.collectAsState()
    LaunchedEffect(Unit) { spacesRepo.refreshSpaces() }

    fun spaceSessions(slug: String, kind: String): List<AgentSessionRow> =
        sessionsForSpace(slug, kind, roles, sessions)

    // Unsaved (dirty) docs per project — offline edits awaiting a save/flush.
    val notesFiles by notes.observeFiles().collectAsState(initial = emptyList())
    val dirtyByProject = remember(notesFiles) {
        notesFiles.filter { it.dirty && it.path.startsWith("projects/") }
            .groupBy { it.path.removePrefix("projects/").substringBefore('/').removeSuffix(".md") }
            .mapValues { it.value.size }
    }

    fun alerts(slug: String, kind: String): SpaceAlerts {
        val ss = spaceSessions(slug, kind)
        return SpaceAlerts(
            attention = ss.count { it.needsAttention },
            working = ss.count { activity[it.id]?.running == true },
            unread = ss.count { it.hasUnread },
            dirty = if (kind == "project") dirtyByProject[slug] ?: 0 else 0,
        )
    }

    val areas = spaces.filter { it.kind == "area" }
    val projects = spaces.filter { it.kind == "project" }
        .sortedWith(compareByDescending<SpacesRepository.SpaceSummary> { alerts(it.slug, it.kind).rank }
            .thenBy { it.status == "dormant" || it.status == "complete" }
            .thenBy { it.title.lowercase() })

    Column(Modifier.fillMaxSize()) {
        io.amar.console.ui.components.PaneTopBar(title = "Spaces", onGrid = onGrid, subtitle = "${projects.size} projects · ${areas.size} areas")
        LazyColumn(Modifier.fillMaxSize()) {
            if (areas.isNotEmpty()) {
                item { SectionHeader("AREAS") }
                items(areas, key = { "a:${it.slug}" }) { sp ->
                    SpaceRow(sp, alerts(sp.slug, sp.kind), onClick = { onOpenSpace("area/${sp.slug}") })
                }
            }
            item { SectionHeader("PROJECTS") }
            items(projects, key = { "p:${it.slug}" }) { sp ->
                SpaceRow(sp, alerts(sp.slug, sp.kind), onClick = { onOpenSpace("project/${sp.slug}") })
            }
        }
    }
}

/** Sessions bound to a space: role frontmatter project/areas join (SPA parity). */
fun sessionsForSpace(
    slug: String,
    kind: String,
    roles: List<AgentsRepository.AgentRole>,
    sessions: List<AgentSessionRow>,
): List<AgentSessionRow> {
    val keys = roles.filter { r ->
        if (kind == "project") r.project == slug else slug in r.areas
    }.map { it.key }.toSet()
    return sessions.filter { it.status != "ended" && it.agentKey in keys }
}

@Composable
private fun SectionHeader(label: String) {
    Text(
        label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 2.dp),
    )
}

/** Per-space alert tallies — ALL surfaced on L1 so no tap-hunting. */
data class SpaceAlerts(val attention: Int, val working: Int, val unread: Int, val dirty: Int) {
    val rank: Int get() = when {
        attention > 0 -> 4
        working > 0 -> 3
        unread > 0 -> 2
        dirty > 0 -> 1
        else -> 0
    }
}

@Composable
private fun SpaceRow(
    sp: SpacesRepository.SpaceSummary,
    alerts: SpaceAlerts,
    onClick: () -> Unit,
) {
    val dim = sp.status == "dormant" || sp.status == "complete"
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
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
                fontWeight = if (alerts.rank >= 2) FontWeight.SemiBold else FontWeight.Normal,
                color = if (dim) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            val meta = listOfNotNull(
                sp.status,
                if (sp.boardPath != null) "board" else null,
                if (sp.fileCount > 0) "${sp.fileCount} files" else null,
            ).joinToString(" · ")
            if (meta.isNotEmpty()) {
                Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // Explicit counts, not a lone dot — everything visible without a tap:
        // red = needs you, amber = working, blue = unread, grey ✎ = unsaved.
        if (alerts.attention > 0) CountBadge(alerts.attention, MaterialTheme.colorScheme.error)
        if (alerts.working > 0) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                androidx.compose.material3.CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp, color = AMBER)
                Text("${alerts.working}", style = MaterialTheme.typography.labelSmall, color = AMBER)
            }
        }
        if (alerts.unread > 0) CountBadge(alerts.unread, MaterialTheme.colorScheme.primary)
        if (alerts.dirty > 0) {
            Text("✎${alerts.dirty}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun CountBadge(count: Int, color: Color) {
    Box(
        Modifier.size(16.dp).clip(CircleShape).background(color),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "$count",
            style = MaterialTheme.typography.labelSmall.copy(fontSize = androidx.compose.ui.unit.TextUnit(9f, androidx.compose.ui.unit.TextUnitType.Sp)),
            color = Color.White, maxLines = 1,
        )
    }
}

@Composable
private fun Dot(color: Color) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
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
    val roles by agents.roles.collectAsState()
    val sessions by agents.observeSessions().collectAsState(initial = emptyList())
    val bound = remember(roles, sessions) { sessionsForSpace(slug, kind, roles, sessions) }
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
        sp?.boardPath?.let { spacesRepo.loadBoard(it) } ?: spacesRepo.clearBoard()
    }
    LaunchedEffect(sp?.boardPath) { sp?.boardPath?.let { spacesRepo.loadBoard(it) } }

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
            "board" -> BoardView(spacesRepo, roles, bound, onOpenSession)
            "agents" -> SpaceAgentsList(agents, bound, kind, slug, onOpenSession)
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
    roles: List<AgentsRepository.AgentRole>,
    bound: List<AgentSessionRow>,
    onOpenSession: (String) -> Unit,
) {
    val loaded by spacesRepo.board.collectAsState()
    val scope = rememberCoroutineScope()
    var cardSheet by remember { mutableStateOf<CardRef?>(null) }
    var addToColumn by remember { mutableStateOf<String?>(null) }
    val board = loaded?.board ?: run {
        Text("Loading board…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
        return
    }
    // Done columns stay in the FILE but hide on screen (SPA parity).
    val visibleCols = board.columns.filter { !KanbanCodec.DONE_COLUMN_RE.matches(it.title) }
    val doneCount = board.columns.filter { KanbanCodec.DONE_COLUMN_RE.matches(it.title) }.sumOf { it.cards.size }

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
                        CardChip(card, roles) { cardSheet = CardRef(col.title, i) }
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

    cardSheet?.let { ref ->
        CardSheet(
            spacesRepo = spacesRepo,
            ref = ref,
            roles = roles,
            bound = bound,
            columns = board.columns.map { it.title },
            onOpenSession = onOpenSession,
            onDismiss = { cardSheet = null },
        )
    }
    addToColumn?.let { colTitle ->
        AddCardSheet(
            column = colTitle,
            onAdd = { text ->
                addToColumn = null
                scope.launch { spacesRepo.mutateBoard { b -> KanbanCodec.addCard(b, colTitle, text) != null } }
            },
            onDismiss = { addToColumn = null },
        )
    }
}

@Composable
private fun CardChip(card: io.amar.console.data.spaces.BoardCard, roles: List<AgentsRepository.AgentRole>, onClick: () -> Unit) {
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
        val hasMeta = card.blocked || card.agentKey != null || card.lines.size > 1
        if (hasMeta) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                if (card.blocked) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        Icon(Icons.Filled.Block, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(11.dp))
                        Text("blocked", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                }
                card.agentKey?.let { key ->
                    val title = roles.firstOrNull { it.key == key }?.title ?: key
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        Icon(Icons.Filled.SmartToy, null, tint = VIOLET, modifier = Modifier.size(11.dp))
                        Text(title, style = MaterialTheme.typography.labelSmall, color = VIOLET, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (card.blockId != null) {
                    // Stamped = dispatched (hub-owned marker).
                    Text("dispatched", style = MaterialTheme.typography.labelSmall, color = GREEN)
                }
                if (card.lines.size > 1) {
                    Text("…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun CardSheet(
    spacesRepo: SpacesRepository,
    ref: CardRef,
    roles: List<AgentsRepository.AgentRole>,
    bound: List<AgentSessionRow>,
    columns: List<String>,
    onOpenSession: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val loaded by spacesRepo.board.collectAsState()
    val card = loaded?.let { KanbanCodec.getCard(it.board, ref) } ?: return
    val scope = rememberCoroutineScope()
    fun mutate(block: (io.amar.console.data.spaces.KanbanBoard) -> Boolean) {
        scope.launch { spacesRepo.mutateBoard(block); onDismiss() }
    }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Text(card.text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            // Detail lines (indented continuations), verbatim minus indent.
            if (card.lines.size > 1) {
                Text(
                    card.lines.drop(1).joinToString("\n") { it.trimStart() },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 6.dp)) {
                Text("in ${ref.column}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (card.blockId != null) Text("dispatched ^${card.blockId}", style = MaterialTheme.typography.labelSmall, color = GREEN)
                if (card.blocked) Text("#blocked", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }

            // Move to… (never a client-side Done shortcut for agent cards —
            // humans certify; Done IS offered since the human is the reviewer.)
            Text("Move to", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (colTitle in columns.filter { it != ref.column }) {
                    Surface(
                        onClick = { mutate { b -> KanbanCodec.moveCard(b, ref, colTitle) } },
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Text(colTitle, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }

            // Assign to… (agent roles; assignment is the delegation trigger
            // once the card sits in an In-Progress column — hub does the rest).
            Text("Assign to", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (role in roles.filter { !it.folder }.sortedBy { it.title.lowercase() }.take(20)) {
                    val selected = card.agentKey == role.key
                    Surface(
                        onClick = {
                            mutate { b ->
                                KanbanCodec.getCard(b, ref)?.let { c ->
                                    c.agentKey = if (selected) null else role.key
                                    KanbanCodec.refreshCardLine(c)
                                    true
                                } ?: false
                            }
                        },
                        shape = RoundedCornerShape(8.dp),
                        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    ) {
                        Text("@${role.key}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }

            Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                TextButton(onClick = {
                    mutate { b ->
                        KanbanCodec.getCard(b, ref)?.let { c ->
                            c.blocked = !c.blocked
                            KanbanCodec.refreshCardLine(c)
                            true
                        } ?: false
                    }
                }) { Text(if (card.blocked) "Unblock" else "Mark #blocked") }
                // Jump to the assignee's live session when it's in this space.
                card.agentKey?.let { key ->
                    bound.firstOrNull { it.agentKey == key }?.let { sess ->
                        TextButton(onClick = { onDismiss(); onOpenSession(sess.id) }) { Text("Open agent") }
                    }
                }
                TextButton(onClick = { mutate { b -> KanbanCodec.deleteCard(b, ref) } }) {
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
                placeholder = { Text("Card text (@key to assign)") },
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

@Composable
private fun SpaceAgentsList(
    agents: AgentsRepository,
    bound: List<AgentSessionRow>,
    kind: String,
    slug: String,
    onOpenSession: (String) -> Unit,
) {
    val activity by agents.activity.collectAsState()
    var creating by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f)) {
            items(bound, key = { it.id }) { s ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenSession(s.id) }.padding(horizontal = 16.dp, vertical = 10.dp),
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
                    Column(Modifier.weight(1f)) {
                        Text(s.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(s.status + if (s.hibernated) " · hibernated" else "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
