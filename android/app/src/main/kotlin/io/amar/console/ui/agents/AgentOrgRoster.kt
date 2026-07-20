package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository

private val VIOLET = Color(0xFFA78BFA)
private val AMBER = Color(0xFFF59E0B)

/**
 * Org roster — a mobile-appropriate LIST view of the agent org chart (grouped
 * by manager into an indented tree). DEGRADED-by-design vs the SPA's canvas
 * node-link chart: no drag-to-reparent canvas, but every role is reachable, its
 * live session opens on tap, and a per-role action menu covers revive/reload/
 * park/delete + reparent + delegate. Ported from AgentOrgChart.tsx +
 * agent-orgchart-helpers.ts (buildDisplayRoot).
 */

/** Pure display node used by the roster. */
data class RosterNode(
    val role: AgentsRepository.AgentRole,
    val depth: Int,
    val danglingManager: String?,
)

/** Build an indented, depth-first roster from the flat role list. Al is the
 *  root; valid `manager` edges nest; managerless/dangling/cyclic hang under Al;
 *  folders sort before agents within a level, then by title. Mirrors
 *  agent-orgchart-helpers.buildDisplayRoot + OR-of-descendant traversal. */
fun buildRoster(roles: List<AgentsRepository.AgentRole>): List<RosterNode> {
    if (roles.isEmpty()) return emptyList()
    val byKey = roles.associateBy { it.key }
    fun validManager(r: AgentsRepository.AgentRole): String? {
        val m = r.manager ?: return null
        if (m == r.key || !byKey.containsKey(m)) return null
        val seen = HashSet<String>(); seen.add(r.key)
        var cur: AgentsRepository.AgentRole? = byKey[m]
        while (cur != null) {
            if (!seen.add(cur.key)) return null // cycle → top-level
            cur = cur.manager?.let { byKey[it] }
        }
        return m
    }
    val childrenOf = HashMap<String, MutableList<AgentsRepository.AgentRole>>()
    val roots = mutableListOf<AgentsRepository.AgentRole>()
    val dangling = HashMap<String, String>()
    val al = byKey["al"]
    for (r in roles) {
        if (r.key == "al") continue
        val mgr = validManager(r)
        if (mgr != null) childrenOf.getOrPut(mgr) { mutableListOf() }.add(r)
        else {
            if (r.manager != null && !byKey.containsKey(r.manager)) dangling[r.key] = r.manager!!
            // managerless roots hang under Al (if Al exists), else true roots.
            if (al != null) childrenOf.getOrPut("al") { mutableListOf() }.add(r) else roots.add(r)
        }
    }
    val cmp = Comparator<AgentsRepository.AgentRole> { a, b ->
        if (a.folder != b.folder) (if (a.folder) -1 else 1)
        else a.title.compareTo(b.title, ignoreCase = true)
    }
    val out = mutableListOf<RosterNode>()
    fun emit(r: AgentsRepository.AgentRole, depth: Int) {
        out.add(RosterNode(r, depth, dangling[r.key]))
        childrenOf[r.key]?.sortedWith(cmp)?.forEach { emit(it, depth + 1) }
    }
    if (al != null) emit(al, 0) else roots.sortedWith(cmp).forEach { emit(it, 0) }
    return out
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrgRosterSheet(
    repo: AgentsRepository,
    onOpenSession: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val roles by repo.roles.collectAsState()
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    val tasks by repo.tasks.collectAsState()
    val nodes = remember(roles) { buildRoster(roles) }
    var infoKey by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).heightIn(max = 600.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text("Org chart", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 4.dp, start = 4.dp))
            if (nodes.isEmpty()) Text("No agent roles yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(4.dp))
            for (node in nodes) {
                val live = sessions.firstOrNull { it.agentKey == node.role.key && it.status != "ended" }
                val openTasks = tasks.count { it.toKey == node.role.key && it.status in setOf("pending", "in_progress", "blocked") }
                RosterRow(node, live?.let { it.status == "running" } ?: false, live != null, openTasks, live?.hasUnread ?: false, live?.needsAttention ?: false,
                    onClick = { if (live != null) onOpenSession(live.id) else infoKey = node.role.key })
            }
            Box(Modifier.size(20.dp))
        }
    }
    infoKey?.let { key ->
        RoleInfoDialog(repo, key, onOpenSession = { onOpenSession(it) }, onDismiss = { infoKey = null })
    }
}

@Composable
private fun RosterRow(
    node: RosterNode,
    running: Boolean,
    live: Boolean,
    openTasks: Int,
    unread: Boolean,
    attention: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable { onClick() }.padding(start = (8 + node.depth * 14).dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        when {
            attention -> Box(Modifier.size(7.dp).clip(androidx.compose.foundation.shape.CircleShape).background(MaterialTheme.colorScheme.error))
            running -> Box(Modifier.size(7.dp).clip(androidx.compose.foundation.shape.CircleShape).background(AMBER))
            unread -> Box(Modifier.size(7.dp).clip(androidx.compose.foundation.shape.CircleShape).background(MaterialTheme.colorScheme.primary))
            else -> Box(Modifier.size(7.dp))
        }
        if (node.role.folder) Icon(Icons.Filled.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(13.dp))
        val (bare, isFork) = TranscriptHelpers.stripForkSuffix(node.role.title)
        Text(
            bare,
            style = MaterialTheme.typography.bodyMedium,
            fontStyle = if (isFork) FontStyle.Italic else FontStyle.Normal,
            color = when {
                isFork -> VIOLET
                !live && !node.role.folder -> MaterialTheme.colorScheme.onSurfaceVariant  // parked = dimmed
                else -> MaterialTheme.colorScheme.onSurface
            },
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
        )
        node.danglingManager?.let { Text("⚠ $it", style = MaterialTheme.typography.labelSmall, color = AMBER, maxLines = 1) }
        if (!live && !node.role.folder) Text("parked", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (openTasks > 0) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("↓$openTasks", style = MaterialTheme.typography.labelSmall, color = VIOLET)
            }
        }
    }
}
