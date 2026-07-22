package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import io.amar.console.data.db.AgentMessageRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

private val json = Json { ignoreUnknownKeys = true }

private val GREEN = Color(0xFF4ADE80)
private val RED = Color(0xFFF87171)

/**
 * Transcript block renderer — the mobile port of AgentMessageBlock.tsx.
 * [result]/[diff] are the tool_result / tool_diff paired to a tool_use (they
 * never render standalone — mirrors the SPA's toolResultsById pairing).
 */
@Composable
fun TranscriptBlock(
    msg: AgentMessageRow,
    result: AgentMessageRow? = null,
    diff: AgentMessageRow? = null,
) {
    val payload = remember(msg.pk) {
        runCatching { json.parseToJsonElement(msg.payloadJson).jsonObject }.getOrNull()
    } ?: return
    when (msg.kind) {
        "user_prompt" -> UserPromptBlock(payload)
        "text" -> TextBlock(payload, msgId = msg.pk.toString())
        "thinking" -> ThinkingBlock(payload)
        "tool_use" -> {
            val tool = payload["toolName"]?.jsonPrimitive?.content
            when (tool) {
                "EnterPlanMode" -> ModeDivider("Entered plan mode")
                "ExitPlanMode" -> PlanCardBlock(result)
                "TodoWrite" -> TodoListBlock(payload["input"] as? JsonObject)
                else -> ToolUseBlock(payload, result, diff)
            }
        }
        "tool_result", "tool_diff" -> { /* rendered inside tool_use */ }
        "error" -> ErrorBlock(payload)
        "result" -> ResultFooterBlock(payload)
        "bg_task" -> { /* handled by dedup in the list; standalone no-op */ }
        else -> { /* unknown kinds skipped */ }
    }
}

// ------------------------------------------------------------------ //

@Composable
private fun UserPromptBlock(p: JsonObject) {
    val content = p["content"]?.jsonPrimitive?.content ?: ""
    val images = (p["images"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.content } ?: emptyList()
    if (content.isBlank() && images.isEmpty()) return
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.End,
    ) {
        if (images.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                items(images) { url ->
                    AsyncImage(
                        model = url, contentDescription = null,
                        modifier = Modifier.heightIn(max = 128.dp).clip(RoundedCornerShape(8.dp)),
                    )
                }
            }
            Spacer(Modifier.size(4.dp))
        }
        if (content.isNotBlank()) {
            MarkdownLite(
                content,
                Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.20f))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
            )
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun TextBlock(p: JsonObject, msgId: String) {
    val raw = p["content"]?.jsonPrimitive?.content ?: p["text"]?.jsonPrimitive?.content ?: return
    val content = remember(raw) { TranscriptHelpers.stripHandoff(raw) }
    if (content.isBlank()) return
    val speakingId by Speech.speakingId.collectAsState()
    val speaking = speakingId == msgId
    val ctx = LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    // No per-message icon column — long-press opens a compact action sheet
    // (copy / read aloud); a stop icon shows only while actually speaking.
    var actions by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .combinedClickable(onClick = {}, onLongClick = { actions = true }),
    ) {
        MarkdownLite(content, Modifier.weight(1f))
        if (speaking) {
            Icon(
                Icons.Filled.Stop,
                contentDescription = "Stop",
                tint = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.size(18.dp).clickable { Speech.toggle(msgId, "", ctx) },
            )
        }
        if (actions) {
            androidx.compose.material3.ModalBottomSheet(onDismissRequest = { actions = false }) {
                Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                    androidx.compose.material3.TextButton(onClick = {
                        clipboard.setText(AnnotatedString(TranscriptHelpers.plainForSpeech(content)))
                        actions = false
                    }) { Text("⧉ Copy text") }
                    androidx.compose.material3.TextButton(onClick = {
                        Speech.toggle(msgId, TranscriptHelpers.plainForSpeech(content), ctx)
                        actions = false
                    }) { Text("🔊 Read aloud") }
                }
            }
        }
    }
}

@Composable
private fun ThinkingBlock(p: JsonObject) {
    val content = p["content"]?.jsonPrimitive?.content ?: return
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.Psychology, contentDescription = "Thinking",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
            Text(
                if (expanded) "Thinking" else "Thinking (${TranscriptHelpers.thinkingCharsLabel(content.length)})",
                style = MaterialTheme.typography.labelSmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (expanded) {
            Text(
                content,
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp, top = 2.dp).heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
            )
        }
    }
}

private fun toolIcon(tool: String): ImageVector = when (tool) {
    "Read", "Write" -> Icons.Filled.Description
    "Edit" -> Icons.Filled.Edit
    "Bash" -> Icons.Filled.Terminal
    "Glob", "Grep" -> Icons.Filled.Search
    "WebSearch", "WebFetch" -> Icons.Filled.Language
    else -> Icons.Filled.Terminal
}

@Composable
private fun ToolUseBlock(p: JsonObject, resultRow: AgentMessageRow?, diffRow: AgentMessageRow?) {
    val tool = p["toolName"]?.jsonPrimitive?.content ?: "tool"
    val input = p["input"] as? JsonObject
    val result = remember(resultRow?.pk) {
        resultRow?.let { runCatching { json.parseToJsonElement(it.payloadJson).jsonObject }.getOrNull() }
    }
    val isError = result?.get("isError")?.jsonPrimitive?.booleanOrNull ?: false
    val detail = remember(p) { toolDetail(tool, input) }
    val diffHunks = remember(diffRow?.pk) {
        diffRow?.let { parseDiffHunks(runCatching { json.parseToJsonElement(it.payloadJson).jsonObject }.getOrNull()) } ?: emptyList()
    }
    var expanded by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            Icon(
                toolIcon(tool), contentDescription = null,
                tint = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(12.dp).padding(top = 1.dp),
            )
            Row(Modifier.weight(1f)) {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Medium, color = if (isError) RED else MaterialTheme.colorScheme.onSurface)) { append(tool) }
                        if (detail.isNotEmpty()) { append("  "); append(detail) }
                    },
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (expanded) 12 else 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (diffHunks.isNotEmpty()) {
                    val stat = TranscriptHelpers.diffStat(diffHunks.flatMap { it.third })
                    Spacer(Modifier.width(6.dp))
                    if (stat.added > 0) Text("+${stat.added}", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = GREEN)
                    if (stat.added > 0 && stat.removed > 0) Text(" ", style = MaterialTheme.typography.labelSmall)
                    if (stat.removed > 0) Text("−${stat.removed}", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = RED)
                }
            }
        }
        // Edits/Writes render their diff inline by default (the terminal experience).
        if (diffHunks.isNotEmpty()) DiffBlock(diffHunks)
        if (expanded && result != null) {
            val content = result["content"]?.jsonPrimitive?.content ?: ""
            Text(
                content.take(4000),
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                fontFamily = FontFamily.Monospace,
                color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .padding(start = 18.dp, top = 4.dp)
                    .fillMaxWidth()
                    .heightIn(max = 240.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(
                        if (isError) MaterialTheme.colorScheme.error.copy(alpha = 0.1f)
                        else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    )
                    .verticalScroll(rememberScrollState())
                    .padding(8.dp),
            )
        }
    }
}

/** Human-readable tool args: primary arg first, rest as key=value (skipping the
 *  bulky/secret keys). Mirrors AgentMessageBlock.tsx ToolDetail. */
private fun toolDetail(tool: String, input: JsonObject?): String {
    if (input == null) return ""
    val primaryKey = mapOf(
        "Read" to "file_path", "Write" to "file_path", "Edit" to "file_path",
        "Bash" to "command", "Glob" to "pattern", "Grep" to "pattern",
        "WebSearch" to "query", "WebFetch" to "url", "Agent" to "description",
    )[tool]
    val skip = setOf("old_string", "new_string", "content", "data", "prompt")
    val sb = StringBuilder()
    if (primaryKey != null) {
        input[primaryKey]?.jsonPrimitive?.content?.let { sb.append(it) }
    }
    val rest = input.entries.filter { (k, v) ->
        k != primaryKey && k !in skip && !(v is JsonPrimitive && v.booleanOrNull == false) && v !is kotlinx.serialization.json.JsonNull
    }
    for ((k, v) in rest) {
        val s = (v as? JsonPrimitive)?.contentOrNullValue() ?: v.toString()
        sb.append(" $k=$s")
    }
    return sb.toString().trim()
}

private fun JsonPrimitive.contentOrNullValue(): String = if (isString) content else content

private fun parseDiffHunks(p: JsonObject?): List<Triple<Int, Int, List<String>>> {
    val hunks = (p?.get("structuredPatch") as? JsonArray ?: p?.get("hunks") as? JsonArray) ?: return emptyList()
    return hunks.mapNotNull { el ->
        val h = el as? JsonObject ?: return@mapNotNull null
        val lines = (h["lines"] as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList()
        Triple(
            h["oldStart"]?.jsonPrimitive?.intOrNull ?: 0,
            h["newStart"]?.jsonPrimitive?.intOrNull ?: 0,
            lines,
        )
    }
}

@Composable
private fun DiffBlock(hunks: List<Triple<Int, Int, List<String>>>) {
    var showAll by remember { mutableStateOf(false) }
    val total = hunks.sumOf { it.third.size }
    val rows = remember(hunks, showAll) { TranscriptHelpers.buildDiffRows(hunks, cap = 80, showAll = showAll) }
    Column(
        Modifier
            .padding(start = 18.dp, top = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 340.dp).verticalScroll(rememberScrollState())) {
            for (r in rows) {
                if (r.kind == "sep") {
                    Text(
                        "···",
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)).padding(horizontal = 8.dp),
                    )
                    continue
                }
                Row(
                    Modifier.fillMaxWidth().background(
                        when (r.kind) {
                            "add" -> GREEN.copy(alpha = 0.12f)
                            "del" -> RED.copy(alpha = 0.12f)
                            else -> Color.Transparent
                        }
                    ),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        (r.lineNo ?: "").toString(),
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                        modifier = Modifier.width(34.dp).padding(horizontal = 4.dp),
                        maxLines = 1,
                    )
                    Text(
                        r.glyph,
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                        fontFamily = FontFamily.Monospace,
                        color = when (r.kind) { "add" -> GREEN; "del" -> RED; else -> Color.Transparent },
                        modifier = Modifier.width(12.dp),
                    )
                    Text(
                        r.text.ifEmpty { " " },
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                        fontFamily = FontFamily.Monospace,
                        color = when (r.kind) {
                            "add" -> GREEN
                            "del" -> RED.copy(alpha = 0.85f)
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.weight(1f).padding(end = 8.dp),
                    )
                }
            }
        }
        if (!showAll && total > 80) {
            Text(
                "Show all $total lines",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.fillMaxWidth().clickable { showAll = true }.background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)).padding(vertical = 3.dp, horizontal = 8.dp),
            )
        }
    }
}

@Composable
private fun ModeDivider(label: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.weight(1f).size(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.SwapHoriz, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(11.dp))
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Medium)
        }
        Box(Modifier.weight(1f).size(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
    }
}

@Composable
private fun PlanCardBlock(resultRow: AgentMessageRow?) {
    val plan = remember(resultRow?.pk) {
        resultRow?.let { runCatching { json.parseToJsonElement(it.payloadJson).jsonObject["content"]?.jsonPrimitive?.content }.getOrNull() }
    }
    var expanded by remember { mutableStateOf(true) }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
        ModeDivider("Exited plan mode")
        if (plan != null) {
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp)),
            ) {
                Row(
                    Modifier.fillMaxWidth().clickable { expanded = !expanded }.background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)).padding(horizontal = 10.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.AutoMirrored.Filled.List, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
                    Text("Plan", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
                }
                if (expanded) MarkdownLite(plan, Modifier.padding(12.dp))
            }
        }
    }
}

@Composable
private fun TodoListBlock(input: JsonObject?) {
    val todos = remember(input) {
        (input?.get("todos") as? JsonArray)?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            Triple(
                o["content"]?.jsonPrimitive?.content ?: "",
                o["status"]?.jsonPrimitive?.content ?: "pending",
                o["activeForm"]?.jsonPrimitive?.content,
            )
        } ?: emptyList()
    }
    if (todos.isEmpty()) return
    val done = todos.count { it.second == "completed" }
    val inProgress = todos.firstOrNull { it.second == "in_progress" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.List, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
            Text("Todos", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
            Text("$done/${todos.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            inProgress?.let {
                Text("· ${it.third ?: it.first}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        for ((content, status, activeForm) in todos) {
            val label = if (status == "in_progress") (activeForm ?: content) else content
            Row(Modifier.padding(start = 4.dp, top = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
                when (status) {
                    "completed" -> Icon(Icons.Filled.Check, contentDescription = null, tint = GREEN, modifier = Modifier.size(12.dp).padding(top = 1.dp))
                    "in_progress" -> CircularProgressIndicator(modifier = Modifier.size(11.dp), strokeWidth = 1.5.dp, color = MaterialTheme.colorScheme.tertiary)
                    else -> Icon(Icons.Filled.Circle, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f), modifier = Modifier.size(9.dp).padding(top = 2.dp))
                }
                Text(
                    label,
                    style = MaterialTheme.typography.bodySmall,
                    color = when (status) {
                        "completed" -> MaterialTheme.colorScheme.onSurfaceVariant
                        "in_progress" -> MaterialTheme.colorScheme.onSurface
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    fontWeight = if (status == "in_progress") FontWeight.Medium else FontWeight.Normal,
                    textDecoration = if (status == "completed") TextDecoration.LineThrough else null,
                )
            }
        }
    }
}

@Composable
private fun ErrorBlock(p: JsonObject) {
    val message = p["message"]?.jsonPrimitive?.content ?: p["content"]?.jsonPrimitive?.content ?: "error"
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.10f))
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
        Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun ResultFooterBlock(p: JsonObject) {
    val duration = p["duration"]?.jsonPrimitive?.longOrNull ?: p["duration_ms"]?.jsonPrimitive?.longOrNull
    val cost = p["cost"]?.jsonPrimitive?.doubleOrNull ?: p["total_cost_usd"]?.jsonPrimitive?.doubleOrNull
    val ttft = p["ttftMs"]?.jsonPrimitive?.longOrNull
    val stopReason = p["stopReason"]?.jsonPrimitive?.content
    val outTokens = (p["tokens"] as? JsonObject)?.get("output")?.jsonPrimitive?.intOrNull
    val models = (p["modelUsage"] as? JsonArray)?.mapNotNull { it as? JsonObject }
        ?.filter { ((it["outputTokens"]?.jsonPrimitive?.intOrNull ?: 0) > 0) || ((it["inputTokens"]?.jsonPrimitive?.intOrNull ?: 0) > 0) }
        ?: emptyList()
    var expanded by remember { mutableStateOf(false) }
    val parts = buildList {
        duration?.let { add("${"%.1f".format(it / 1000.0)}s") }
        ttft?.let { add("ttft ${"%.1f".format(it / 1000.0)}s") }
        cost?.let { add("$" + "%.4f".format(it)) }
        outTokens?.let { add("$it out") }
    }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 2.dp)) {
        Row(
            Modifier.clickable(enabled = models.size > 1) { expanded = !expanded },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                parts.joinToString("  "),
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (stopReason != null && stopReason != "end_turn") {
                Text(stopReason, style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.tertiary)
            }
            if (models.size > 1) Text("· ${models.size} models", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (expanded && models.isNotEmpty()) {
            for (m in models) {
                val id = m["model"]?.jsonPrimitive?.content ?: continue
                val inTok = m["inputTokens"]?.jsonPrimitive?.intOrNull ?: 0
                val outTok = m["outputTokens"]?.jsonPrimitive?.intOrNull ?: 0
                val c = m["costUSD"]?.jsonPrimitive?.doubleOrNull
                Text(
                    "${TranscriptHelpers.shortModel(id)}: $inTok in · $outTok out${c?.let { " · $" + "%.4f".format(it) } ?: ""}",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
}

/** A background-task lifecycle chip (deduped per taskId by the caller). */
@Composable
fun BgTaskChip(p: JsonObject) {
    val status = p["status"]?.jsonPrimitive?.content ?: "started"
    val taskType = p["taskType"]?.jsonPrimitive?.content
    val isAgent = taskType == "local_agent"
    val description = p["description"]?.jsonPrimitive?.content
    val summary = p["summary"]?.jsonPrimitive?.content
    val label = (description ?: summary ?: if (isAgent) "Subagent" else "Background task").take(40)
    Row(
        Modifier
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .border(
                1.dp,
                if (status == "failed") MaterialTheme.colorScheme.error.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant,
                RoundedCornerShape(12.dp),
            )
            .padding(horizontal = 8.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (status) {
            "started" -> CircularProgressIndicator(modifier = Modifier.size(9.dp), strokeWidth = 1.dp)
            "failed" -> Icon(Icons.Filled.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(9.dp))
            else -> Icon(Icons.Filled.Check, contentDescription = null, tint = GREEN, modifier = Modifier.size(9.dp))
        }
        Text(if (isAgent) "Agent" else "Shell", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), fontWeight = FontWeight.Medium)
        Text(label, style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = if (status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (status != "started" && summary != null && summary != label) {
            Text("· $summary", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ------------------------------------------------------------------ //
// Markdown-lite: bold / italic / inline-code / code fences (lang + copy) /
// headings / bullets / pipe tables / links / bare-URL autolinking.

@Composable
fun MarkdownLite(text: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val blocks = remember(text) { splitBlocks(text) }
        for (block in blocks) {
            when (block) {
                is MdBlock.Code -> CodeFence(block.lang, block.code)
                is MdBlock.Table -> MdTable(block.header, block.rows)
                is MdBlock.Lines -> for (line in block.lines) { if (line.isNotBlank()) RenderMdLine(line) }
            }
        }
    }
}

private sealed interface MdBlock {
    data class Code(val lang: String, val code: String) : MdBlock
    data class Table(val header: List<String>, val rows: List<List<String>>) : MdBlock
    data class Lines(val lines: List<String>) : MdBlock
}

private fun splitBlocks(text: String): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val lines = text.lines()
    var i = 0
    val plain = mutableListOf<String>()
    fun flushPlain() { if (plain.isNotEmpty()) { out.add(MdBlock.Lines(plain.toList())); plain.clear() } }
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trimStart()
        if (trimmed.startsWith("```")) {
            flushPlain()
            val lang = trimmed.removePrefix("```").trim()
            val code = StringBuilder()
            i++
            while (i < lines.size && !lines[i].trimStart().startsWith("```")) { code.appendLine(lines[i]); i++ }
            i++ // skip closing fence
            out.add(MdBlock.Code(lang, code.toString().trimEnd()))
            continue
        }
        // Table: header line + separator line
        if (i + 1 < lines.size && TranscriptHelpers.isTableHeader(line, lines[i + 1])) {
            flushPlain()
            val header = TranscriptHelpers.tableCells(line)
            i += 2
            val rows = mutableListOf<List<String>>()
            while (i < lines.size && lines[i].contains("|") && lines[i].isNotBlank()) {
                rows.add(TranscriptHelpers.tableCells(lines[i])); i++
            }
            out.add(MdBlock.Table(header, rows))
            continue
        }
        plain.add(line); i++
    }
    flushPlain()
    return out
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun CodeFence(lang: String, code: String) {
    // Long-press anywhere on the block copies it — no dedicated button row
    // stealing vertical space. A transient overlay chip confirms the copy.
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { kotlinx.coroutines.delay(1200); copied = false } }
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
            .combinedClickable(
                onClick = {},
                onLongClick = { clipboard.setText(AnnotatedString(code)); copied = true },
            ),
    ) {
        Text(
            code,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 6.dp),
        )
        if (lang.isNotEmpty() || copied) {
            Text(
                if (copied) "copied" else lang.uppercase(),
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 8.sp),
                color = if (copied) GREEN else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                modifier = Modifier.align(Alignment.TopEnd).padding(horizontal = 5.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun MdTable(header: List<String>, rows: List<List<String>>) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp)),
    ) {
        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))) {
            for (cell in header) {
                Text(inlineMd(cell), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f).padding(6.dp))
            }
        }
        for (row in rows) {
            Row(Modifier.fillMaxWidth().border(0.5.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))) {
                for (j in header.indices) {
                    Text(inlineMd(row.getOrElse(j) { "" }), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(6.dp))
                }
            }
        }
    }
}

@Composable
private fun RenderMdLine(line: String) {
    when {
        line.startsWith("### ") -> Text(inlineMd(line.removePrefix("### ")), style = MaterialTheme.typography.titleSmall)
        line.startsWith("## ") -> Text(inlineMd(line.removePrefix("## ")), style = MaterialTheme.typography.titleMedium)
        line.startsWith("# ") -> Text(inlineMd(line.removePrefix("# ")), style = MaterialTheme.typography.titleLarge)
        line.startsWith("- ") || line.startsWith("* ") ->
            Row {
                Text("•  ", style = MaterialTheme.typography.bodyMedium)
                Text(inlineMd(line.drop(2)), style = MaterialTheme.typography.bodyMedium)
            }
        else -> Text(inlineMd(line), style = MaterialTheme.typography.bodyMedium)
    }
}

/** Inline `code` + **bold** + *italic* + [links](url) + bare-URL autolink. */
private fun inlineMd(s: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < s.length) {
        when {
            s.startsWith("**", i) -> {
                val end = s.indexOf("**", i + 2)
                if (end > 0) { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(s.substring(i + 2, end)) }; i = end + 2 }
                else { append(s[i]); i++ }
            }
            s[i] == '`' -> {
                val end = s.indexOf('`', i + 1)
                if (end > 0) { withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x33FFFFFF))) { append(s.substring(i + 1, end)) }; i = end + 1 }
                else { append(s[i]); i++ }
            }
            s[i] == '[' -> {
                val close = s.indexOf(']', i + 1)
                if (close > 0 && close + 1 < s.length && s[close + 1] == '(') {
                    val urlEnd = s.indexOf(')', close + 2)
                    if (urlEnd > 0) {
                        val label = s.substring(i + 1, close)
                        val url = s.substring(close + 2, urlEnd)
                        if (isSafeScheme(url) && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:") || url.startsWith("tel:"))) {
                            // LinkAnnotation makes the span actually TAPPABLE —
                            // withStyle alone painted it blue but dead.
                            withLink(androidx.compose.ui.text.LinkAnnotation.Url(url)) {
                                withStyle(SpanStyle(color = Color(0xFF60A5FA), textDecoration = TextDecoration.Underline)) { append(label) }
                            }
                        } else append(label)
                        i = urlEnd + 1
                        continue
                    }
                }
                append(s[i]); i++
            }
            s.startsWith("http://", i) || s.startsWith("https://", i) -> {
                var end = i
                while (end < s.length && !s[end].isWhitespace()) end++
                var url = s.substring(i, end)
                // Trailing punctuation split back to plain text.
                var trailing = ""
                while (url.isNotEmpty() && url.last() in ".,;:!?") { trailing = url.last() + trailing; url = url.dropLast(1) }
                withLink(androidx.compose.ui.text.LinkAnnotation.Url(url)) {
                    withStyle(SpanStyle(color = Color(0xFF60A5FA), textDecoration = TextDecoration.Underline)) { append(url) }
                }
                append(trailing)
                i = end
            }
            else -> {
                // italic (single * not part of **)
                if (s[i] == '*' && (i + 1 >= s.length || s[i + 1] != '*')) {
                    val end = s.indexOf('*', i + 1)
                    if (end > 0) { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(s.substring(i + 1, end)) }; i = end + 1 }
                    else { append(s[i]); i++ }
                } else { append(s[i]); i++ }
            }
        }
    }
}

private fun isSafeScheme(url: String): Boolean =
    url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:") ||
        url.startsWith("tel:") || url.startsWith("#") || url.startsWith("/")
