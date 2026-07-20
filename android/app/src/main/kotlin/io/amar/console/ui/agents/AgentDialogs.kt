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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import kotlinx.coroutines.launch

private val AMBER = Color(0xFFF59E0B)
private val VIOLET = Color(0xFFA78BFA)

// Known model ids for the fleet picker optgroups (model-config.ts).
private val FIRST_PARTY = listOf("claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001")
private val BEDROCK = listOf(
    "us.anthropic.claude-fable-5", "us.anthropic.claude-opus-4-8", "us.anthropic.claude-opus-4-7",
    "us.anthropic.claude-sonnet-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0",
)

// ------------------------------------------------------------------ //
// Fleet model picker + backend switch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetModelSheet(repo: AgentsRepository, onDismiss: () -> Unit) {
    val state by repo.modelState.collectAsState()
    val connected by repo.connectedFlow.collectAsState()
    val scope = rememberCoroutineScope()
    var switching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Fleet model", style = MaterialTheme.typography.titleMedium)
            // Backend segmented control.
            Text("Auth backend", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((id, label) in listOf("first_party" to "Max sub", "bedrock" to "Bedrock")) {
                    OutlinedButton(
                        onClick = {
                            if (state.backend == id || switching || !connected) return@OutlinedButton
                            switching = true; error = null
                            scope.launch {
                                runCatching { repo.setAgentBackend(id) }.onFailure { error = it.message }
                                switching = false
                            }
                        },
                        enabled = connected && !switching && state.backend != id,
                        modifier = Modifier.weight(1f),
                    ) {
                        if (switching && state.backend != id) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
                        else Text(label + if (state.backend == id) " ✓" else "")
                    }
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }

            if (state.lockedByEnv) {
                Text("Locked by CLAUDE_MODEL env — picker disabled", style = MaterialTheme.typography.labelSmall, color = AMBER)
            }
            Text("Model (restarts live sessions)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            // Current chain first (fallback labels), then Direct + Bedrock optgroups of ids not in chain.
            val chain = state.chain
            for ((i, m) in chain.withIndex()) {
                ModelRow(m, active = m == state.model, label = if (i == 0) "" else "(fallback $i)", enabled = connected && !state.lockedByEnv) { repo.setAgentModel(m) }
            }
            val notInChain = { list: List<String> -> list.filter { it !in chain } }
            if (notInChain(FIRST_PARTY).isNotEmpty()) {
                Text("Direct (first-party)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                for (m in notInChain(FIRST_PARTY)) ModelRow(m, active = m == state.model, enabled = connected && !state.lockedByEnv) { repo.setAgentModel(m) }
            }
            if (notInChain(BEDROCK).isNotEmpty()) {
                Text("Bedrock", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                for (m in notInChain(BEDROCK)) ModelRow(m, active = m == state.model, enabled = connected && !state.lockedByEnv) { repo.setAgentModel(m) }
            }
            Box(Modifier.size(20.dp))
        }
    }
}

@Composable
private fun ModelRow(model: String, active: Boolean, label: String = "", enabled: Boolean, onSelect: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp))
            .then(if (active) Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)) else Modifier)
            .clickable(enabled = enabled) { onSelect() }.padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(TranscriptHelpers.shortModel(model), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
        if (label.isNotEmpty()) Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (active) Text("●", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }
}

// ------------------------------------------------------------------ //
// Role info dialog (charter / goals / memory + reparent + revive/reload/park/delete)

@Composable
fun RoleInfoDialog(repo: AgentsRepository, roleKey: String, onOpenSession: (String) -> Unit, onDismiss: () -> Unit) {
    val roles by repo.roles.collectAsState()
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    val role = remember(roles, roleKey) { roles.firstOrNull { it.key == roleKey } }
    val live = sessions.firstOrNull { it.agentKey == roleKey && it.status != "ended" }
    val isAl = roleKey == "al"
    var confirmDelete by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(role?.title ?: "Role not found", style = MaterialTheme.typography.titleMedium)
                Text("$roleKey${if (live == null && !isAl && role?.folder != true) " · parked" else ""}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace)
            }
        },
        text = {
            if (role == null) { Text("Role not found.") } else {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (role.goals.isNotEmpty()) {
                        Text("Goals", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        for (g in role.goals) Text("• $g", style = MaterialTheme.typography.bodySmall)
                    }
                    val split = role.charter.split(Regex("(?m)^##\\s+Memory\\s*$"), limit = 2)
                    val charter = split[0].trim()
                    Text("Charter", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(charter.ifEmpty { "— (the agent maintains this in its file)" }, style = MaterialTheme.typography.bodySmall)
                    if (split.size > 1) {
                        Text("Memory", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                        Text(split[1].trim(), style = MaterialTheme.typography.bodySmall)
                    }
                    Text("~/.config/console/agents/$roleKey.md", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    // Manager reparent (not for Al).
                    if (!isAl) {
                        Text("Reports to", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                        var showMgr by remember { mutableStateOf(false) }
                        Box {
                            OutlinedButton(onClick = { showMgr = true }, modifier = Modifier.fillMaxWidth()) {
                                Text(roles.firstOrNull { it.key == role.manager }?.title ?: "— (root)", maxLines = 1)
                            }
                            androidx.compose.material3.DropdownMenu(expanded = showMgr, onDismissRequest = { showMgr = false }) {
                                androidx.compose.material3.DropdownMenuItem(text = { Text("— (root)") }, onClick = { repo.setManager(roleKey, null); showMgr = false })
                                for (r in roles.filter { it.key != roleKey }.sortedBy { it.title }) {
                                    androidx.compose.material3.DropdownMenuItem(
                                        text = { Text((if (r.folder) "📁 " else "") + r.title) },
                                        onClick = { repo.setManager(roleKey, r.key); showMgr = false },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (live != null) {
                    TextButton(onClick = { onOpenSession(live.id); onDismiss() }) { Text("Open") }
                    TextButton(onClick = { repo.reloadSession(live.id); onDismiss() }) { Text("Reload") }
                    if (!isAl) TextButton(onClick = { repo.killSession(live.id); onDismiss() }) { Text("Park") }
                } else if (!isAl && role?.folder != true) {
                    TextButton(onClick = { repo.reviveAgent(roleKey); onDismiss() }) { Text("Revive") }
                }
                if (!isAl) TextButton(onClick = { confirmDelete = true }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete role?") },
            text = { Text(if (role?.folder == true) "Its children become roots." else "Removes the role file and kills any live session.") },
            confirmButton = { TextButton(onClick = { repo.deleteRole(roleKey); confirmDelete = false; onDismiss() }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

// ------------------------------------------------------------------ //
// Quick switcher — fuzzy-jump to any agent

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickSwitcher(repo: AgentsRepository, onOpenSession: (String) -> Unit, onDismiss: () -> Unit) {
    val roles by repo.roles.collectAsState()
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    var query by remember { mutableStateOf("") }

    data class Item(val key: String?, val sessionId: String?, val title: String, val running: Boolean, val fork: Boolean, val parked: Boolean)
    val items = remember(roles, sessions, query) {
        // Live non-ended sessions + parked roles (excl. folders and Al handled specially).
        val liveByKey = sessions.filter { it.status != "ended" }
        val out = mutableListOf<Item>()
        // Al first when empty query.
        val al = sessions.firstOrNull { it.id == "al" }
        if (al != null) out.add(Item(null, al.id, "Al", al.status == "running", false, false))
        for (s in liveByKey.filter { it.id != "al" }) {
            val (bare, fork) = TranscriptHelpers.stripForkSuffix(s.name)
            out.add(Item(s.agentKey, s.id, bare, s.status == "running", fork, false))
        }
        for (r in roles.filter { it.key != "al" && !it.folder }) {
            if (out.any { it.key == r.key }) continue
            if (liveByKey.any { it.agentKey == r.key }) continue
            out.add(Item(r.key, null, r.title, false, r.fork, true))
        }
        val q = query.trim().lowercase()
        if (q.isEmpty()) out
        else out.mapNotNull { item ->
            val t = item.title.lowercase()
            val contig = t.indexOf(q)
            val score = when {
                contig >= 0 -> contig
                isSubsequence(q, t) -> 1000 + t.indexOf(q.first())
                else -> return@mapNotNull null
            }
            item to score
        }.sortedBy { it.second }.map { it.first }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(max = 500.dp)) {
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(18.dp)) },
                placeholder = { Text("Jump to agent…") },
            )
            if (items.isEmpty()) Text("No agents match", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 400.dp)) {
                items(items) { item ->
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            if (item.sessionId != null) onOpenSession(item.sessionId)
                            else if (item.key != null) repo.reviveAgent(item.key)
                            onDismiss()
                        }.padding(vertical = 8.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (item.fork) Icon(Icons.AutoMirrored.Filled.CallSplit, contentDescription = null, tint = VIOLET, modifier = Modifier.size(13.dp))
                        if (item.running) Box(Modifier.size(7.dp).clip(androidx.compose.foundation.shape.CircleShape).background(AMBER))
                        Text(item.title, style = MaterialTheme.typography.bodyMedium, fontStyle = if (item.fork) FontStyle.Italic else FontStyle.Normal, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (item.parked) Text("parked · revive", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** Ordered-subsequence test for the fuzzy matcher. */
private fun isSubsequence(needle: String, haystack: String): Boolean {
    var i = 0
    for (c in haystack) { if (i < needle.length && needle[i] == c) i++ }
    return i == needle.length
}
