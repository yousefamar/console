package io.amar.console.ui.agents

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicNone
import androidx.compose.material.icons.filled.NotificationImportant
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.amar.console.data.agents.AgentsRepository
import io.amar.console.data.agents.Mic
import io.amar.console.data.db.AgentMessageRow
import io.amar.console.data.db.AgentSessionRow
import io.amar.console.ui.components.ComposerHandle
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val jsonLenient = Json { ignoreUnknownKeys = true }
private val AMBER = Color(0xFFF59E0B)
private val VIOLET = Color(0xFFA78BFA)
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionActionsSheet(
    session: AgentSessionRow,
    micOwner: Boolean,
    onDismiss: () -> Unit,
    onRename: (String) -> Unit,
    onKill: () -> Unit,
    onMarkUnread: () -> Unit,
    onMarkRead: () -> Unit,
    onGenerateTitle: () -> Unit,
    onReloadHistory: () -> Unit,
    onFork: () -> Unit,
    onMerge: () -> Unit,
    onMic: () -> Unit,
    onShowInfo: (() -> Unit)?,
) {
    var renaming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf(session.name) }
    val isFork = session.parentClaudeSessionId != null
    val canMerge = session.status != "ended" && (isFork || (session.agentKey != null && session.agentKey != "al"))
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(session.name, style = MaterialTheme.typography.titleMedium)
            if (renaming) {
                OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = { if (name.isNotBlank()) onRename(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Save") }
            } else {
                SheetItem("✎ Rename") { renaming = true }
                SheetItem("✦ Generate title") { onGenerateTitle(); onDismiss() }
                SheetItem("↻ Reload history") { onReloadHistory(); onDismiss() }
                SheetItem("⑃ Fork") { onFork(); onDismiss() }
                if (onShowInfo != null) SheetItem("ⓘ Show info") { onShowInfo() }
                SheetItem("✓✓ Mark read") { onMarkRead(); onDismiss() }
                SheetItem("● Mark unread") { onMarkUnread(); onDismiss() }
                SheetItem(if (micOwner) "🎙 Release mic to Al" else "🎙 Give mic to this agent") { onMic(); onDismiss() }
                if (canMerge) SheetItem("⤵ Merge into parent") { onMerge(); onDismiss() }
                if (session.status != "ended") {
                    androidx.compose.material3.TextButton(onClick = { onKill(); onDismiss() }) {
                        Text("■ End session", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
            Spacer(Modifier.size(28.dp))
        }
    }
}

@Composable
private fun SheetItem(label: String, onClick: () -> Unit) {
    androidx.compose.material3.TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Text(label, modifier = Modifier.fillMaxWidth())
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)



@Composable
fun AgentSessionScreen(repo: AgentsRepository, sessionId: String, onBack: () -> Unit = {}, onComposerChange: (String) -> Unit = {}) {
    val messages by repo.observeMessages(sessionId).collectAsState(initial = emptyList())
    val approvals by repo.approvals.collectAsState()
    val sessionApprovals = remember(approvals) { approvals.filter { it.sessionId == sessionId } }
    val scope = rememberCoroutineScope()
    val sessions by repo.observeSessions().collectAsState(initial = emptyList())
    val session = remember(sessions) { sessions.firstOrNull { it.id == sessionId } }
    val connected by repo.connectedFlow.collectAsState()
    val activityMap by repo.activity.collectAsState()
    val act = activityMap[sessionId]
    val modelState by repo.modelState.collectAsState()
    val slashCommands by repo.slashCommands.collectAsState()

    // Load history if empty.
    LaunchedEffect(sessionId) {
        if (repo.observeMessages(sessionId, 1).let { false }) Unit // no-op guard
    }

    val listState = rememberLazyListState()
    var hasOlder by remember(sessionId) { mutableStateOf(false) }
    LaunchedEffect(sessionId, messages.size) { hasOlder = repo.hasOlder(sessionId) }

    // Infinite upward scroll: when the reverse-layout list nears the top (= the
    // OLDEST message index is visible), request older history.
    LaunchedEffect(listState, sessionId) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { lastVisible ->
                if (hasOlder && lastVisible >= messages.size - 3 && messages.isNotEmpty()) repo.loadOlder(sessionId)
            }
    }

    val showJumpToBottom by remember { derivedStateOf { listState.firstVisibleItemIndex > 3 } }

    Column(Modifier.fillMaxSize().imePadding()) {
        val permMode = session?.permissionMode
        io.amar.console.ui.components.PaneTopBar(
            title = session?.let { TranscriptHelpers.stripForkSuffix(it.name).first } ?: "…",
            subtitle = listOfNotNull(
                if (act?.running == true) "working…" else session?.status,
                act?.currentTool?.let { "⚙ $it" },
                if (!connected) "offline" else null,
            ).joinToString(" · ").ifEmpty { null },
            onBack = onBack,
            actions = {
                if (act?.running == true) {
                    IconButton(onClick = { repo.interrupt(sessionId) }) {
                        Icon(Icons.Filled.StopCircle, contentDescription = "Interrupt", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(22.dp))
                    }
                }
                if (session?.hasUnread == true || session?.needsAttention == true) {
                    IconButton(onClick = { repo.markRead(sessionId) }) {
                        Icon(Icons.Filled.DoneAll, contentDescription = "Mark read", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                    }
                }
            },
        )
        // Status bar: model pin · permission mode · git · sub-agents · cron.
        StatusBar(repo, session, act, modelState, sessionId)

        if (sessionApprovals.isNotEmpty()) ApprovalCard(repo, sessionApprovals.first())

        // Pair tool_result / tool_diff to their tool_use; dedup bg_task.
        val paired = remember(messages) { pairMessages(messages) }
        // Unread divider anchor: the FIRST unread absIndex, captured once on
        // entry so it doesn't jump as new messages auto-mark read. The divider
        // renders just before this message (in chronological order).
        val dividerAnchor = remember(sessionId) {
            val lri = session?.lastReadIndex ?: 0L
            if (session?.hasUnread == true) paired.filter { !it.bgTaskDup && it.msg.absIndex >= lri && it.msg.kind != "user_prompt" }
                .minByOrNull { it.msg.absIndex }?.msg?.absIndex else null
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                Modifier.fillMaxSize(),
                state = listState,
                reverseLayout = true,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp),
            ) {
                // Live streaming tail (thinking preview + tool-input being typed)
                // renders at the visual bottom = first item in reverseLayout.
                if (act != null && (act.streamingThinking.isNotEmpty() || (act.toolInputName != null && act.toolInputJson.isNotEmpty()))) {
                    item(key = "streaming-tail") { StreamingTail(act) }
                }
                items(paired, key = { it.msg.pk }) { row ->
                    if (row.bgTaskDup) return@items
                    // reverseLayout: render the block, then (below it in list =
                    // above it visually) the NEW divider when this is the anchor.
                    if (row.bgTask != null) {
                        BgTaskChip(runCatching { jsonLenient.parseToJsonElement(row.bgTask.payloadJson).jsonObject }.getOrNull() ?: return@items)
                    } else {
                        TranscriptBlock(row.msg, row.result, row.diff)
                    }
                    if (dividerAnchor != null && row.msg.absIndex == dividerAnchor) UnreadDivider()
                }
            }
            // Jump-to-bottom pill.
            androidx.compose.animation.AnimatedVisibility(
                visible = showJumpToBottom,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            ) {
                androidx.compose.material3.Surface(
                    onClick = { scope.launch { listState.animateScrollToItem(0) } },
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primary,
                    shadowElevation = 4.dp,
                ) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Jump to bottom", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.padding(6.dp).size(20.dp))
                }
            }
        }
        // Live task list (CLI TaskCreate/TaskUpdate), pinned above the
        // composer — SPA TodoPanel parity.
        val todosMap by repo.todos.collectAsState()
        todosMap[sessionId]?.let { TodoPanel(it) }
        // Running status row.
        if (act?.running == true || act?.statusText != null) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
                Text(
                    act.statusText ?: act.currentTool?.let { "running $it" } ?: "Processing…",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val ctx = androidx.compose.ui.platform.LocalContext.current
        val handle = remember { ComposerHandle() }
        // PTT compose delivery: drop a finished utterance into THIS composer
        // when it (or Al, its default owner) owns the mic, unsent for review.
        val compose by Mic.compose.collectAsState()
        val micOwner by Mic.owner.collectAsState()
        var consumedSeq by remember { mutableStateOf(compose.seq) }
        LaunchedEffect(compose.seq) {
            if (compose.seq != consumedSeq && compose.text.isNotEmpty()) {
                consumedSeq = compose.seq
                val target = compose.owner
                if (target == sessionId || (target == null && sessionId == "al") || (target == "al" && sessionId == "al")) {
                    val existing = handle.text
                    handle.setText(if (existing.isBlank()) compose.text else "${existing.trimEnd()} ${compose.text}")
                }
            }
        }
        AgentComposer(
            placeholder = when {
                // The hub routes a send during a plan review into plan feedback
                // (deny-with-reason, Claude keeps planning) — say so instead of
                // looking frozen.
                sessionApprovals.any { it.toolName == "ExitPlanMode" } -> "Plan feedback — Claude keeps planning"
                sessionApprovals.any { it.toolName == "AskUserQuestion" } -> "Answer the question above first…"
                session?.id == "al" -> "Message Al…"
                act?.running == true || session?.status == "running" -> "Follow up…"
                else -> "Prompt"
            },
            draftKey = "agent:$sessionId",
            slashCommands = slashCommands,
            handle = handle,
            onSend = { text ->
                scope.launch { repo.sendPrompt(sessionId, text) }
                repo.markRead(sessionId)
                scope.launch { listState.animateScrollToItem(0) } // reverseLayout: 0 = bottom
            },
            onTextChange = onComposerChange,
            onSendWithAttachments = { text, uris ->
                scope.launch { repo.sendPrompt(sessionId, text, uris, ctx) }
                repo.markRead(sessionId)
                scope.launch { listState.animateScrollToItem(0) }
            },
        )
    }
}

/** A transcript row with its paired result/diff (or a bg-task chip). */
private data class PairedRow(
    val msg: AgentMessageRow,
    val result: AgentMessageRow? = null,
    val diff: AgentMessageRow? = null,
    val bgTask: AgentMessageRow? = null,
    val bgTaskDup: Boolean = false,
)

/** Pair tool_use → tool_result/tool_diff by toolUseId; dedup bg_task per taskId
 *  (one chip at the first-event position, later events suppressed). Mirrors the
 *  SPA MessageList pairing/dedup. `messages` is DESC (newest first). */
private fun pairMessages(messages: List<AgentMessageRow>): List<PairedRow> {
    val byToolUse = HashMap<String, AgentMessageRow>()
    val diffByToolUse = HashMap<String, AgentMessageRow>()
    // bg_task: find the FIRST (in chronological order = last in this DESC list)
    // occurrence per taskId to render, and the LATEST payload.
    val bgFirstPk = HashMap<String, Long>()      // taskId → pk of the chronologically-first row
    val bgLatest = HashMap<String, AgentMessageRow>()
    for (m in messages) {
        val p = runCatching { jsonLenient.parseToJsonElement(m.payloadJson).jsonObject }.getOrNull() ?: continue
        when (m.kind) {
            "tool_result" -> p["toolUseId"]?.jsonPrimitive?.content?.let { if (it !in byToolUse) byToolUse[it] = m }
            "tool_diff" -> p["toolUseId"]?.jsonPrimitive?.content?.let { if (it !in diffByToolUse) diffByToolUse[it] = m }
            "bg_task" -> {
                val taskId = p["taskId"]?.jsonPrimitive?.content ?: continue
                // Track the LATEST payload per taskId (highest absIndex).
                if (taskId !in bgLatest || m.absIndex > (bgLatest[taskId]?.absIndex ?: -1)) bgLatest[taskId] = m
            }
        }
    }
    // Compute first (chronological) pk per taskId.
    for (m in messages.sortedBy { it.absIndex }) {
        if (m.kind != "bg_task") continue
        val p = runCatching { jsonLenient.parseToJsonElement(m.payloadJson).jsonObject }.getOrNull() ?: continue
        val taskId = p["taskId"]?.jsonPrimitive?.content ?: continue
        if (taskId !in bgFirstPk) bgFirstPk[taskId] = m.pk
    }
    val out = ArrayList<PairedRow>(messages.size)
    for (m in messages) {
        when (m.kind) {
            "tool_result", "tool_diff" -> { /* rendered inside tool_use — skip */ }
            "tool_use" -> {
                val p = runCatching { jsonLenient.parseToJsonElement(m.payloadJson).jsonObject }.getOrNull()
                val toolUseId = p?.get("toolUseId")?.jsonPrimitive?.content
                out.add(PairedRow(m, result = toolUseId?.let { byToolUse[it] }, diff = toolUseId?.let { diffByToolUse[it] }))
            }
            "bg_task" -> {
                val p = runCatching { jsonLenient.parseToJsonElement(m.payloadJson).jsonObject }.getOrNull()
                val taskId = p?.get("taskId")?.jsonPrimitive?.content
                if (taskId != null && bgFirstPk[taskId] == m.pk) {
                    out.add(PairedRow(m, bgTask = bgLatest[taskId] ?: m))
                } else {
                    out.add(PairedRow(m, bgTaskDup = true))
                }
            }
            else -> out.add(PairedRow(m))
        }
    }
    return out
}

@Composable
private fun UnreadDivider() {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.weight(1f).size(1.dp).background(MaterialTheme.colorScheme.error.copy(alpha = 0.6f)))
        Text("NEW", style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Medium)
        Box(Modifier.weight(1f).size(1.dp).background(MaterialTheme.colorScheme.error.copy(alpha = 0.6f)))
    }
}

@Composable
private fun StreamingTail(act: AgentsRepository.Activity) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp)) {
        if (act.streamingThinking.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.dp)
                Text(
                    "Thinking… ${act.streamingThinking.takeLast(160)}",
                    style = MaterialTheme.typography.labelSmall, fontStyle = FontStyle.Italic,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (act.toolInputName != null && act.toolInputJson.isNotEmpty()) {
            val preview = remember(act.toolInputJson) { TranscriptHelpers.mineToolInput(act.toolInputJson) }
            Text(
                "${act.toolInputName}${preview.label?.let { " $it" } ?: ""}${preview.body?.let { "\n$it" } ?: ""} ▍",
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 6, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
