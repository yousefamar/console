package io.amar.console.ui.mail

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.amar.console.data.mail.MailFormat
import io.amar.console.data.mail.MailRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Compose mode — matches the SPA's ComposeEditor modes. */
enum class ComposeMode { REPLY, REPLY_ALL, FORWARD, COMPOSE }

/**
 * Full mail composer sheet: From picker (only >1 alias), To/Cc/Bcc contact
 * autocomplete, Subject (compose/forward), body, attachment chips (filename +
 * size + remove), and paperclip multi-select. Mirrors ComposeEditor.tsx —
 * prefill, smart from-address, reply-all Cc filtering, and Gmail-style quoted
 * original are computed in [prefill]. Sends through [MailRepository] so it
 * queues offline like everything else.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MailComposeSheet(
    repo: MailRepository,
    mode: ComposeMode,
    threadId: String?,
    /** Message being replied-to/forwarded (last message of the thread, or a
     *  specific one from the ⋯ menu). Fields drive prefill. */
    replyContext: ReplyContext?,
    onDismiss: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    // Draft key: one slot per compose context so a fresh compose and a reply
    // to thread X keep independent drafts (SPA parity: draft survives dismiss).
    val draftKey = remember(mode, threadId, replyContext?.messageId) {
        if (mode == ComposeMode.COMPOSE) "compose"
        else "${mode.name.lowercase()}:${threadId ?: ""}:${replyContext?.messageId ?: ""}"
    }

    var aliases by remember { mutableStateOf<List<MailFormat.Alias>>(emptyList()) }
    var from by remember { mutableStateOf("") }
    var to by remember { mutableStateOf("") }
    var cc by remember { mutableStateOf("") }
    var bcc by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var quotedHtml by remember { mutableStateOf<String?>(null) }
    var attachments by remember { mutableStateOf<List<Uri>>(emptyList()) }
    // Attachments carried from a forwarded message (already base64, no Uri).
    var carried by remember { mutableStateOf<List<MailRepository.OutAttachment>>(emptyList()) }
    var showFromPicker by remember { mutableStateOf(false) }
    var showCc by remember { mutableStateOf(mode == ComposeMode.REPLY_ALL || mode == ComposeMode.COMPOSE) }
    var sending by remember { mutableStateOf(false) }
    var userEmail by remember { mutableStateOf("") }

    // Load aliases + prefill once; a saved draft for this context wins over prefill.
    var draftLoaded by remember { mutableStateOf(false) }
    LaunchedEffect(mode, threadId, replyContext?.messageId) {
        userEmail = repo.userEmail()
        val a = repo.aliases()
        aliases = a
        val pf = prefill(mode, replyContext, a, userEmail)
        from = pf.from
        to = pf.to
        cc = pf.cc
        subject = pf.subject
        quotedHtml = pf.quotedHtml
        if (pf.cc.isNotBlank()) showCc = true
        repo.loadDraft(draftKey)?.let { d ->
            if (d.from.isNotBlank()) from = d.from
            if (d.to.isNotBlank()) to = d.to
            cc = d.cc; bcc = d.bcc
            if (d.subject.isNotBlank()) subject = d.subject
            body = d.body
            if (d.cc.isNotBlank() || d.bcc.isNotBlank()) showCc = true
        }
        draftLoaded = true
        // Forward carries over the original's non-inline attachments (SPA parity).
        if (mode == ComposeMode.FORWARD && replyContext != null) {
            kotlinx.coroutines.withContext(Dispatchers.IO) {
                carried = runCatching { repo.forwardAttachments(replyContext.messageId) }.getOrDefault(emptyList())
            }
        }
    }

    // Debounced draft autosave; saveDraft deletes the slot when all fields are blank.
    LaunchedEffect(from, to, cc, bcc, subject, body, draftLoaded) {
        if (!draftLoaded || sending) return@LaunchedEffect
        delay(500)
        repo.saveDraft(draftKey, MailRepository.ComposeDraft(from, to, cc, bcc, subject, body))
    }

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris -> if (uris.isNotEmpty()) attachments = attachments + uris }

    fun doSend() {
        if (sending) return
        sending = true
        scope.launch {
            // Plain-text body → minimal HTML paragraphs so the quote nests below.
            val userHtml = bodyToHtml(body)
            val html = MailFormat.assembleSendHtml(userHtml, quotedHtml)
            val outAtts = carried + withContext(Dispatchers.IO) { attachments.mapNotNull { readAttachment(ctx, it) } }
            when (mode) {
                ComposeMode.COMPOSE -> repo.sendCompose(
                    to = to.trim(), cc = cc.ifBlank { null }, subject = subject.trim(),
                    html = html, from = from.ifBlank { null }, attachments = outAtts,
                )
                ComposeMode.FORWARD -> repo.sendReply(
                    threadId = threadId ?: return@launch, to = to.trim(), cc = cc.ifBlank { null },
                    subject = subject.trim(), html = html, from = from.ifBlank { null },
                    attachments = outAtts, autoArchive = false,
                )
                else -> repo.sendReply(
                    threadId = threadId ?: return@launch, to = to.trim(), cc = cc.ifBlank { null },
                    subject = subject.trim(), html = html, from = from.ifBlank { null },
                    attachments = outAtts, autoArchive = true,
                )
            }
            repo.clearDraft(draftKey)
            onDismiss()
        }
    }

    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface),
    ) {
        // From picker (only if >1 alias)
        if (aliases.size > 1) {
            Box {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("From", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(
                        Modifier.clickable { showFromPicker = !showFromPicker },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(from.ifBlank { userEmail }, style = MaterialTheme.typography.bodySmall)
                        Icon(Icons.Filled.ExpandMore, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                androidx.compose.material3.DropdownMenu(expanded = showFromPicker, onDismissRequest = { showFromPicker = false }) {
                    for (alias in aliases) {
                        androidx.compose.material3.DropdownMenuItem(
                            text = {
                                Text(
                                    alias.email + (alias.name.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: ""),
                                    color = if ((from.ifBlank { userEmail }) == alias.email) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                )
                            },
                            onClick = { from = alias.email; showFromPicker = false },
                        )
                    }
                }
            }
            Divider()
        }

        // To — auto-focused for compose/forward (SPA focuses To after 100ms).
        RecipientField("To", to, { to = it }, repo,
            showTrailing = mode == ComposeMode.REPLY_ALL || mode == ComposeMode.COMPOSE || mode == ComposeMode.REPLY,
            autoFocus = mode == ComposeMode.COMPOSE || mode == ComposeMode.FORWARD,
            trailing = {
                if (!showCc) TextButton(onClick = { showCc = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp)) {
                    Text("Cc/Bcc", style = MaterialTheme.typography.labelSmall)
                }
            })
        Divider()
        if (showCc) {
            RecipientField("Cc", cc, { cc = it }, repo)
            Divider()
            RecipientField("Bcc", bcc, { bcc = it }, repo)
            Divider()
        }
        // Subject (compose/forward)
        if (mode == ComposeMode.COMPOSE || mode == ComposeMode.FORWARD) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Sub", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(width = 28.dp, height = 16.dp))
                BasicTextField(
                    value = subject, onValueChange = { subject = it },
                    textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
            }
            Divider()
        }
        // Body
        Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).heightIn(min = 90.dp, max = 260.dp)) {
            if (body.isEmpty()) Text("Write your message...", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            BasicTextField(
                value = body, onValueChange = { body = it },
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        // Attachment chips (carried-over forward attachments + newly picked files)
        if (attachments.isNotEmpty() || carried.isNotEmpty()) {
            FlowRow(Modifier.fillMaxWidth().padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (a in carried) {
                    AttachmentChip(a.filename, base64Size(a.data), onRemove = { carried = carried - a })
                }
                for (uri in attachments) {
                    AttachmentChip(displayName(ctx, uri), attachmentSize(ctx, uri), onRemove = { attachments = attachments - uri })
                }
            }
        }
        // Actions
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                androidx.compose.material3.Button(
                    enabled = !sending && (to.isNotBlank() || body.isNotBlank()),
                    onClick = { doSend() },
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, null, modifier = Modifier.size(16.dp))
                    Text("Send", modifier = Modifier.padding(start = 6.dp))
                }
                IconButton(onClick = { filePicker.launch("*/*") }) {
                    Icon(Icons.Filled.AttachFile, "Attach", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                }
            }
            TextButton(onClick = { scope.launch { repo.clearDraft(draftKey) }; onDismiss() }) { Text("Discard") }
        }
    }
}

/** Recipient row with hub-backed contact autocomplete (local first, remote merged). */
@Composable
private fun RecipientField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    repo: MailRepository,
    showTrailing: Boolean = false,
    autoFocus: Boolean = false,
    trailing: @Composable () -> Unit = {},
) {
    var suggestions by remember { mutableStateOf<List<MailRepository.MailContact>>(emptyList()) }
    var open by remember { mutableStateOf(false) }
    val focusRequester = remember { androidx.compose.ui.focus.FocusRequester() }
    if (autoFocus) LaunchedEffect(Unit) { delay(100); runCatching { focusRequester.requestFocus() } }

    // Debounced autocomplete on the last comma-separated token.
    LaunchedEffect(value) {
        val token = value.substringAfterLast(',').trim()
        if (token.isEmpty() || token.contains('>')) { open = false; suggestions = emptyList(); return@LaunchedEffect }
        delay(100)
        val local = repo.localContacts().filter {
            it.name.contains(token, true) || it.email.contains(token, true)
        }.take(8)
        suggestions = local
        open = local.isNotEmpty()
        if (token.length >= 2) {
            val remote = repo.searchContacts(token)
            val localEmails = local.map { it.email.lowercase() }.toSet()
            val merged = (local + remote.filter { it.email.lowercase() !in localEmails }).take(10)
            if (merged.size > local.size) { suggestions = merged; open = true }
        }
    }

    fun selectContact(c: MailRepository.MailContact) {
        val parts = value.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        if (parts.isNotEmpty()) parts.removeAt(parts.lastIndex)
        parts.add(if (c.name.isNotBlank()) "${c.name} <${c.email}>" else c.email)
        onChange(parts.joinToString(", ") + ", ")
        open = false; suggestions = emptyList()
    }

    Column {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(width = 28.dp, height = 16.dp))
            BasicTextField(
                value = value, onValueChange = onChange,
                textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                singleLine = true,
                modifier = Modifier.weight(1f).focusRequester(focusRequester),
            )
            if (showTrailing) trailing()
        }
        if (open && suggestions.isNotEmpty()) {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 180.dp).padding(horizontal = 8.dp)) {
                items(suggestions, key = { it.email }) { c ->
                    Row(
                        Modifier.fillMaxWidth().clickable { selectContact(c) }.padding(horizontal = 8.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(c.name.ifBlank { c.email }, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (c.name.isNotBlank()) Text(c.email, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentChip(name: String, size: Long, onRemove: () -> Unit) {
    Row(
        Modifier
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(Icons.Filled.AttachFile, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(11.dp))
        Text(name, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthInChip())
        if (size > 0) Text("(${MailFormat.formatFileSize(size)})", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Icon(Icons.Filled.Close, "Remove", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp).clickable(onClick = onRemove))
    }
}

private fun Modifier.widthInChip(): Modifier = this.widthIn(max = 150.dp)

@Composable
private fun Divider() = Box(Modifier.fillMaxWidth().size(height = 1.dp, width = 1.dp).background(MaterialTheme.colorScheme.outlineVariant))

private fun esc(t: String): String = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/** Plain-text body → simple HTML (paragraphs on blank lines, <br> on newlines). */
private fun bodyToHtml(text: String): String {
    if (text.isBlank()) return ""
    return text.split(Regex("\\n{2,}")).joinToString("") { para ->
        "<p>" + esc(para).replace("\n", "<br>") + "</p>"
    }
}

/** Approx decoded byte size of a base64 string (for the chip's size label). */
private fun base64Size(b64: String): Long = (b64.length.toLong() * 3) / 4

private fun displayName(ctx: android.content.Context, uri: Uri): String =
    queryName(ctx, uri) ?: uri.lastPathSegment ?: "attachment"

private fun attachmentSize(ctx: android.content.Context, uri: Uri): Long = runCatching {
    ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) { val i = c.getColumnIndex(android.provider.OpenableColumns.SIZE); if (i >= 0 && !c.isNull(i)) return c.getLong(i) }
    }
    0L
}.getOrDefault(0L)

private fun queryName(ctx: android.content.Context, uri: Uri): String? = runCatching {
    ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) { val i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME); if (i >= 0) return c.getString(i) }
    }
    null
}.getOrNull()

/** Read a content Uri into an [MailRepository.OutAttachment] (base64 body). */
private fun readAttachment(ctx: android.content.Context, uri: Uri): MailRepository.OutAttachment? = runCatching {
    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    val name = displayName(ctx, uri)
    val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
    MailRepository.OutAttachment(name, mime, android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
}.getOrNull()
