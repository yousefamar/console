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
private val FIRST_PARTY = listOf("claude-fable-5-1", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001")
private val BEDROCK = listOf(
    "us.anthropic.claude-fable-5-1", "us.anthropic.claude-fable-5", "us.anthropic.claude-opus-4-8", "us.anthropic.claude-opus-4-7",
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
