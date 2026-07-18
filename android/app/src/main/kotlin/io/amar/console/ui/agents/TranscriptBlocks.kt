package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.amar.console.data.db.AgentMessageRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val json = Json { ignoreUnknownKeys = true }

/** Transcript block renderer — the mobile port of AgentMessageBlock.tsx. */
@Composable
fun TranscriptBlock(msg: AgentMessageRow) {
    val payload = remember(msg.pk) {
        runCatching { json.parseToJsonElement(msg.payloadJson).jsonObject }.getOrNull()
    } ?: return
    when (msg.kind) {
        "user_prompt" -> UserPromptBlock(payload)
        "text" -> TextBlock(payload)
        "thinking" -> ThinkingBlock(payload)
        "tool_use" -> ToolUseBlock(payload)
        "tool_result" -> ToolResultBlock(payload)
        "tool_diff" -> ToolDiffBlock(payload)
        "error" -> ErrorBlock(payload)
        "result" -> ResultFooterBlock(payload)
        "bg_task" -> BgTaskBlock(payload)
        else -> { /* unknown kinds skipped */ }
    }
}

// ------------------------------------------------------------------ //

@Composable
private fun UserPromptBlock(p: JsonObject) {
    val content = p["content"]?.jsonPrimitive?.content ?: return
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Text(
            content,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.20f))
                .padding(horizontal = 12.dp, vertical = 7.dp),
        )
    }
}

@Composable
private fun TextBlock(p: JsonObject) {
    val content = p["content"]?.jsonPrimitive?.content
        ?: p["text"]?.jsonPrimitive?.content ?: return
    MarkdownLite(content, Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
}

@Composable
private fun ThinkingBlock(p: JsonObject) {
    val content = p["content"]?.jsonPrimitive?.content ?: return
    var expanded by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(horizontal = 12.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Filled.Psychology, contentDescription = "Thinking",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        if (expanded) {
            Text(
                content,
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                "thought for ${content.length} chars — tap to expand",
                style = MaterialTheme.typography.labelSmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ToolUseBlock(p: JsonObject) {
    val tool = p["toolName"]?.jsonPrimitive?.content ?: "tool"
    val input = p["input"] as? JsonObject
    val primaryArg = remember(p) {
        when (tool) {
            "Bash" -> input?.get("command")?.jsonPrimitive?.content
            "Read", "Edit", "Write" -> input?.get("file_path")?.jsonPrimitive?.content?.substringAfterLast('/')
            "Grep" -> input?.get("pattern")?.jsonPrimitive?.content
            "Agent", "Task" -> input?.get("description")?.jsonPrimitive?.content
            "WebFetch" -> input?.get("url")?.jsonPrimitive?.content
            else -> input?.entries?.firstOrNull()?.value?.jsonPrimitive?.content
        }?.take(80)
    }
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("⚙", style = MaterialTheme.typography.labelSmall)
            Text(
                buildString {
                    append(tool)
                    if (primaryArg != null) { append("  "); append(primaryArg) }
                },
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (expanded) 10 else 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (expanded && input != null) {
            Text(
                input.toString().take(1000),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 18.dp, top = 2.dp),
            )
        }
    }
}

@Composable
private fun ToolResultBlock(p: JsonObject) {
    val content = p["content"]?.jsonPrimitive?.content ?: return
    val isError = p["isError"]?.jsonPrimitive?.content == "true"
    if (content.isBlank()) return
    var expanded by remember { mutableStateOf(false) }
    Text(
        if (expanded) content.take(3000) else content.take(120).replace('\n', ' ') + if (content.length > 120) "…" else "",
        style = MaterialTheme.typography.labelSmall,
        fontFamily = FontFamily.Monospace,
        color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(horizontal = 12.dp, vertical = 1.dp)
            .padding(start = 18.dp),
    )
}

@Composable
private fun ToolDiffBlock(p: JsonObject) {
    val filePath = p["filePath"]?.jsonPrimitive?.content ?: return
    val hunks = (p["structuredPatch"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return
    val lines = remember(p) {
        hunks.flatMap { h -> (h["lines"] as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() } ?: emptyList() }
    }
    val adds = lines.count { it.startsWith("+") }
    val dels = lines.count { it.startsWith("-") }
    var expanded by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 3.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .clickable { expanded = !expanded }
            .padding(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                filePath.substringAfterLast('/'),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text("+$adds", style = MaterialTheme.typography.labelSmall, color = Color(0xFF4ADE80))
            Text("−$dels", style = MaterialTheme.typography.labelSmall, color = Color(0xFFF87171))
        }
        if (expanded) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 300.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(top = 4.dp),
            ) {
                for (line in lines.take(200)) {
                    Text(
                        line,
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                        fontFamily = FontFamily.Monospace,
                        color = when {
                            line.startsWith("+") -> Color(0xFF4ADE80)
                            line.startsWith("-") -> Color(0xFFF87171)
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun ErrorBlock(p: JsonObject) {
    val message = p["message"]?.jsonPrimitive?.content
        ?: p["content"]?.jsonPrimitive?.content ?: "error"
    Text(
        "⚠ $message",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.10f))
            .padding(8.dp),
    )
}

@Composable
private fun ResultFooterBlock(p: JsonObject) {
    val duration = p["duration_ms"]?.jsonPrimitive?.content?.toLongOrNull()
    val cost = p["total_cost_usd"]?.jsonPrimitive?.content?.toDoubleOrNull()
        ?: p["cost_usd"]?.jsonPrimitive?.content?.toDoubleOrNull()
    val parts = listOfNotNull(
        duration?.let { "${it / 1000}s" },
        cost?.let { "$" + String.format("%.3f", it) },
    )
    Text(
        if (parts.isEmpty()) "— turn complete —" else "— ${parts.joinToString(" · ")} —",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
    )
}

@Composable
private fun BgTaskBlock(p: JsonObject) {
    val summary = p["summary"]?.jsonPrimitive?.content
        ?: p["task_type"]?.jsonPrimitive?.content ?: "background task"
    Text(
        "⏳ $summary",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 1.dp),
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}

// ------------------------------------------------------------------ //
// Markdown-lite: bold / inline-code / code fences / headings / bullets.
// Full markdown lib comes later; this covers 95% of agent output legibly.

@Composable
fun MarkdownLite(text: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val segments = remember(text) { splitFences(text) }
        for ((isCode, segment) in segments) {
            if (isCode) {
                Text(
                    segment.trimEnd(),
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
                        .padding(8.dp),
                )
            } else {
                for (line in segment.lines()) {
                    if (line.isBlank()) continue
                    RenderMdLine(line)
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

private fun splitFences(text: String): List<Pair<Boolean, String>> {
    val out = mutableListOf<Pair<Boolean, String>>()
    var inCode = false
    val current = StringBuilder()
    for (line in text.lines()) {
        if (line.trimStart().startsWith("```")) {
            if (current.isNotEmpty()) out.add(inCode to current.toString())
            current.clear()
            inCode = !inCode
        } else {
            current.appendLine(line)
        }
    }
    if (current.isNotEmpty()) out.add(inCode to current.toString())
    return out
}

/** Inline `code` + **bold** spans. */
private fun inlineMd(s: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < s.length) {
        when {
            s.startsWith("**", i) -> {
                val end = s.indexOf("**", i + 2)
                if (end > 0) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(s.substring(i + 2, end)) }
                    i = end + 2
                } else { append(s[i]); i++ }
            }
            s[i] == '`' -> {
                val end = s.indexOf('`', i + 1)
                if (end > 0) {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x33FFFFFF))) {
                        append(s.substring(i + 1, end))
                    }
                    i = end + 1
                } else { append(s[i]); i++ }
            }
            else -> { append(s[i]); i++ }
        }
    }
}
