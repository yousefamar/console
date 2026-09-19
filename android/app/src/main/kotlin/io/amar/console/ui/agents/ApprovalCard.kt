package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import io.amar.console.ui.components.DictatedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val json = Json { ignoreUnknownKeys = true }

/**
 * Tool-approval card, port of AgentToolApproval.tsx:
 *  - AskUserQuestion → real options UI (chips, multiSelect, Other free-text,
 *    multi-question pager) producing the {questions,answers} payload the CLI
 *    expects — a generic Approve button CANNOT answer these.
 *  - ExitPlanMode → plan text (scrollable) + Approve plan / Keep planning.
 *  - Bash → command block; Edit/Write → file path + content preview.
 *  - Everything else → pretty-printed input JSON.
 */
@Composable
fun ApprovalCard(repo: AgentsRepository, approval: AgentsRepository.Approval) {
    val input = remember(approval.requestId) {
        runCatching { json.parseToJsonElement(approval.inputJson).jsonObject }.getOrNull()
            ?: JsonObject(emptyMap())
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when (approval.toolName) {
            "AskUserQuestion" -> AskUserQuestionUi(repo, approval, input)
            "ExitPlanMode" -> PlanApprovalUi(repo, approval, input)
            else -> GenericApprovalUi(repo, approval, input)
        }
    }
}

// ------------------------------------------------------------------ //

/**
 * One question per page (desktop AgentToolApproval pager): header + counter,
 * vertical option rows with descriptions, free-text field, then a pinned
 * footer of prev / dots / next + "Send all (n/N)". The body scrolls inside a
 * cap of half the space left below the status bar — the card lives in the
 * screen's outer Column, so an uncapped body with many options grew past the
 * screen and took its own Send button with it (^soft-orca).
 */
@Composable
private fun AskUserQuestionUi(
    repo: AgentsRepository,
    approval: AgentsRepository.Approval,
    input: JsonObject,
) {
    val questions = remember(input) { AskQuestions.parse(input) }
    if (questions.isEmpty()) return
    // Keyed on requestId so a new approval resets the state (no leak).
    var page by remember(approval.requestId) { mutableIntStateOf(0) }
    var selections by remember(approval.requestId) { mutableStateOf(questions.map { emptySet<Int>() }) }
    var freeTexts by remember(approval.requestId) { mutableStateOf(questions.map { "" }) }
    val multi = questions.size > 1
    val q = questions[page.coerceIn(0, questions.lastIndex)]
    val answeredCount = questions.indices.count { AskQuestions.isAnswered(questions[it], selections[it], freeTexts[it]) }
    val allAnswered = answeredCount == questions.size

    Text(
        if (multi) "Claude is asking · ${page + 1}/${questions.size}" else "Claude is asking",
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
    )
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val bodyMax = if (maxHeight != Dp.Infinity) (maxHeight * 0.5f).coerceAtLeast(120.dp) else 320.dp
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = bodyMax)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            q.header?.let {
                Text(it.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(q.question, style = MaterialTheme.typography.bodyMedium)
            q.options.forEachIndexed { i, opt ->
                val on = i in selections[page]
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (on) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background)
                        .border(
                            1.dp,
                            if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                            RoundedCornerShape(8.dp),
                        )
                        .clickable { selections = selections.toMutableList().also { it[page] = AskQuestions.toggle(q, it[page], i) } }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    Text(opt.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    opt.description?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            // Keyed per page: leaving a page disposes the field, which cancels
            // a dictation mid-sentence instead of routing its tail to the next
            // question (desktop stops dictation on a page flip for the same reason).
            key(page) {
                DictatedTextField(
                    value = freeTexts[page],
                    onValueChange = { v -> freeTexts = freeTexts.toMutableList().also { it[page] = v } },
                    placeholder = if (q.options.isEmpty()) "Type your response…" else "Select above or type a response…",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (multi) {
            IconButton(onClick = { page-- }, enabled = page > 0, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.ChevronLeft, contentDescription = "Previous question", modifier = Modifier.size(20.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                questions.indices.forEach { i ->
                    val done = AskQuestions.isAnswered(questions[i], selections[i], freeTexts[i])
                    Box(
                        Modifier
                            .size(if (i == page) 10.dp else 8.dp)
                            .clip(CircleShape)
                            .background(
                                when {
                                    i == page -> MaterialTheme.colorScheme.primary
                                    done -> MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)
                                    else -> MaterialTheme.colorScheme.outlineVariant
                                },
                            )
                            .clickable { page = i },
                    )
                }
            }
            IconButton(onClick = { page++ }, enabled = page < questions.lastIndex, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.ChevronRight, contentDescription = "Next question", modifier = Modifier.size(20.dp))
            }
        }
        Spacer(Modifier.weight(1f))
        TextButton(
            onClick = { repo.deny(approval.sessionId, approval.requestId) },
            contentPadding = PaddingValues(horizontal = 8.dp),
        ) { Text("Dismiss", maxLines = 1) }
        Button(
            enabled = allAnswered,
            onClick = {
                repo.approve(approval.sessionId, approval.requestId, AskQuestions.payload(questions, selections, freeTexts).toString())
            },
            contentPadding = PaddingValues(horizontal = 12.dp),
        ) { Text(if (multi) "Send all ($answeredCount/${questions.size})" else "Send", maxLines = 1) }
    }
}

// ------------------------------------------------------------------ //

@Composable
private fun PlanApprovalUi(
    repo: AgentsRepository,
    approval: AgentsRepository.Approval,
    input: JsonObject,
) {
    val plan = input["plan"]?.jsonPrimitive?.content ?: "(no plan text)"
    var comment by remember(approval.requestId) { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Text("Plan review", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 260.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.background)
            .padding(8.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(plan, style = MaterialTheme.typography.bodySmall)
    }
    DictatedTextField(
        value = comment,
        onValueChange = { comment = it },
        placeholder = "Optional — comment on the plan…",
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = {
            repo.approve(approval.sessionId, approval.requestId)
            // Approve-with-comment: the text follows as a normal prompt. Sent
            // AFTER approve so the hub's plan-feedback routing (which turns a
            // send during a pending plan review into a deny) doesn't grab it.
            val text = comment.trim()
            if (text.isNotEmpty()) scope.launch { repo.sendPrompt(approval.sessionId, text) }
        }) { Text("Approve plan") }
        // With feedback text Claude keeps planning against the comment.
        OutlinedButton(onClick = { repo.deny(approval.sessionId, approval.requestId, comment.trim().ifEmpty { "keep planning" }) }) { Text("Keep planning") }
    }
}

// ------------------------------------------------------------------ //

@Composable
private fun GenericApprovalUi(
    repo: AgentsRepository,
    approval: AgentsRepository.Approval,
    input: JsonObject,
) {
    Text(
        "Approval: ${approval.toolName}",
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
    )
    val preview = remember(input) {
        when (approval.toolName) {
            "Bash" -> input["command"]?.jsonPrimitive?.content ?: approval.inputJson
            "Edit" -> buildString {
                append(input["file_path"]?.jsonPrimitive?.content ?: "")
                append("\n− ")
                append(input["old_string"]?.jsonPrimitive?.content?.take(300) ?: "")
                append("\n+ ")
                append(input["new_string"]?.jsonPrimitive?.content?.take(300) ?: "")
            }
            "Write" -> {
                val path = input["file_path"]?.jsonPrimitive?.content ?: ""
                val len = input["content"]?.jsonPrimitive?.content?.length ?: 0
                "$path\n($len chars)"
            }
            else -> approval.inputJson.take(600)
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 180.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.background)
            .padding(8.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(preview, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { repo.approve(approval.sessionId, approval.requestId) }) { Text("Approve") }
        OutlinedButton(onClick = { repo.deny(approval.sessionId, approval.requestId) }) { Text("Deny") }
        TextButton(onClick = { repo.approveAlways(approval.sessionId, approval.requestId, approval.toolName) }) {
            Text("Always ${approval.toolName}", maxLines = 1)
        }
    }
}
