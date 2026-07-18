package io.amar.console.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.agents.AgentsRepository
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

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

@Composable
private fun AskUserQuestionUi(
    repo: AgentsRepository,
    approval: AgentsRepository.Approval,
    input: JsonObject,
) {
    val questions = remember(input) {
        (input["questions"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
    }
    // question text -> selected option labels; free-text rides as a one-element list.
    var answers by remember { mutableStateOf(mapOf<String, List<String>>()) }
    var otherDrafts by remember { mutableStateOf(mapOf<String, String>()) }

    Text("Question from the agent", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)

    for (q in questions) {
        val qText = q["question"]?.jsonPrimitive?.content ?: continue
        val multi = q["multiSelect"]?.jsonPrimitive?.booleanOrNull ?: false
        val options = (q["options"] as? JsonArray)?.mapNotNull {
            (it as? JsonObject)?.get("label")?.jsonPrimitive?.content
        } ?: emptyList()
        val selected = answers[qText] ?: emptyList()

        Text(qText, style = MaterialTheme.typography.bodyMedium)
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (opt in options) {
                FilterChip(
                    selected = opt in selected,
                    onClick = {
                        answers = answers + (qText to if (multi) {
                            if (opt in selected) selected - opt else selected + opt
                        } else listOf(opt))
                    },
                    label = { Text(opt, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                )
            }
        }
        OutlinedTextField(
            value = otherDrafts[qText] ?: "",
            onValueChange = { otherDrafts = otherDrafts + (qText to it) },
            placeholder = { Text("Other…", style = MaterialTheme.typography.bodySmall) },
            modifier = Modifier.fillMaxWidth(),
            textStyle = MaterialTheme.typography.bodySmall,
            singleLine = true,
        )
    }

    val complete = questions.all { q ->
        val qText = q["question"]?.jsonPrimitive?.content ?: return@all true
        !(answers[qText].isNullOrEmpty() && otherDrafts[qText].isNullOrBlank())
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            enabled = complete,
            onClick = {
                // Answers schema: Record<question, string[]> (free-text wins if typed).
                val merged = buildJsonObject {
                    put("questions", input["questions"] ?: JsonArray(emptyList()))
                    putJsonObject("answers") {
                        for (q in questions) {
                            val qText = q["question"]?.jsonPrimitive?.content ?: continue
                            val other = otherDrafts[qText]?.trim().orEmpty()
                            val chosen = if (other.isNotEmpty()) listOf(other) else answers[qText] ?: emptyList()
                            put(qText, JsonArray(chosen.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                        }
                    }
                }
                repo.approve(approval.sessionId, approval.requestId, merged.toString())
            },
        ) { Text("Answer") }
        OutlinedButton(onClick = { repo.deny(approval.sessionId, approval.requestId) }) { Text("Dismiss") }
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
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { repo.approve(approval.sessionId, approval.requestId) }) { Text("Approve plan") }
        OutlinedButton(onClick = { repo.deny(approval.sessionId, approval.requestId, "keep planning") }) { Text("Keep planning") }
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
