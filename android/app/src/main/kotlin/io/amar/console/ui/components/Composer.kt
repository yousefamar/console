package io.amar.console.ui.components

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import io.amar.console.core.Dictation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Imperative handle: lets a parent read/replace the draft text from
 *  outside (mention autocomplete insertion). */
class ComposerHandle {
    internal var getter: () -> String = { "" }
    internal var setter: (String) -> Unit = {}
    val text: String get() = getter()
    fun setText(value: String) = setter(value)
}

/**
 * WhatsApp-style composer: pill input (grows to 5 lines), attach button
 * (system picker, any file type), dictation mic (hub /stt, live transcript
 * appears in the input), filled round send button. Draft survives rotation.
 *
 * [onSendWithAttachments] receives (text, uris) — text may be empty when
 * only attachments are sent. When null, attach UI is hidden (plain text
 * composer, e.g. agents until image prompts land).
 *
 * [aboveInput] renders directly above the input row (mention suggestions).
 */
@Composable
fun Composer(
    placeholder: String,
    draftKey: String,
    onSend: (String) -> Unit,
    onTextChange: (String) -> Unit = {},
    onSendWithAttachments: ((String, List<Uri>) -> Unit)? = null,
    handle: ComposerHandle? = null,
    aboveInput: (@Composable () -> Unit)? = null,
) {
    val context = LocalContext.current
    // Durable draft: loads on entry, persists on every edit (blank = cleared).
    // Survives navigation, process death, and restarts — unlike rememberSaveable.
    var draft by remember(draftKey) {
        mutableStateOf(io.amar.console.core.DraftStore.get(context, draftKey))
    }
    LaunchedEffect(draft, draftKey) {
        kotlinx.coroutines.delay(300)
        io.amar.console.core.DraftStore.put(context, draftKey, draft)
    }
    var attachments by remember(draftKey) { mutableStateOf<List<Uri>>(emptyList()) }
    val dictation by Dictation.state.collectAsState()
    if (handle != null) {
        handle.getter = { draft }
        handle.setter = { draft = it; onTextChange(it) }
    }

    // While dictating, the live transcript renders appended to the draft.
    val displayText = if (dictation.active && dictation.transcript.isNotEmpty()) {
        (draft.trimEnd() + " " + dictation.transcript).trim()
    } else draft

    // Committed dictation (mic button OR the hardware PTT key while this
    // composer is on screen) folds into the draft here — single append path.
    LaunchedEffect(Unit) {
        Dictation.committed.collect { text ->
            draft = (draft.trimEnd() + " " + text).trim()
            onTextChange(draft)
        }
    }
    val canSend = displayText.isNotBlank() || attachments.isNotEmpty()

    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris -> if (uris.isNotEmpty()) attachments = attachments + uris }

    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> if (granted) Dictation.start() }

    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background),
    ) {
        if (attachments.isNotEmpty()) {
            LazyRow(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(attachments) { uri ->
                    // Resolve display metadata off the main thread (name/size/mime).
                    val meta by androidx.compose.runtime.produceState<AttachmentMeta?>(null, uri) {
                        value = withContext(Dispatchers.IO) { queryAttachmentMeta(context, uri) }
                    }
                    if (meta?.isImage != false) {
                        // Image (or still-resolving): thumbnail with a remove badge.
                        Box {
                            AsyncImage(
                                model = uri,
                                contentDescription = meta?.name,
                                modifier = Modifier
                                    .size(64.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(MaterialTheme.colorScheme.surfaceVariant),
                            )
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "Remove",
                                tint = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .size(20.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.background.copy(alpha = 0.7f))
                                    .clickable { attachments = attachments - uri }
                                    .padding(3.dp),
                            )
                        }
                    } else {
                        // Non-image: paperclip + filename + human size chip.
                        val m = meta!!
                        Row(
                            Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .padding(horizontal = 8.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(Icons.Filled.AttachFile, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Column {
                                Text(
                                    m.name, style = MaterialTheme.typography.labelSmall,
                                    maxLines = 1,
                                    modifier = Modifier.widthIn(max = 140.dp),
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                )
                                if (m.sizeBytes >= 0) Text(
                                    formatBytes(m.sizeBytes),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Icon(
                                Icons.Filled.Close, "Remove",
                                Modifier.size(16.dp).clip(CircleShape).clickable { attachments = attachments - uri },
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
        if (dictation.active) {
            Text(
                if (dictation.transcript.isEmpty()) "Listening…" else dictation.transcript,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                maxLines = 2,
            )
        }
        aboveInput?.invoke()
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (onSendWithAttachments != null) {
                IconButton(onClick = { filePicker.launch("*/*") }, modifier = Modifier.size(40.dp)) {
                    Icon(
                        Icons.Filled.AttachFile, contentDescription = "Attach",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(20.dp),
                    )
                }
                // Paste ALL clipboard images (FEATURES chat #8). The button is
                // always shown when attach is enabled (reading the clipboard on
                // every recomposition would spam Android 12+'s paste toast); the
                // read happens only on tap.
                IconButton(
                    onClick = {
                        val imgs = clipboardImageUris(context).filter { it !in attachments }
                        if (imgs.isNotEmpty()) attachments = attachments + imgs
                    },
                    modifier = Modifier.size(40.dp),
                ) {
                    Icon(
                        Icons.Filled.ContentPaste, contentDescription = "Paste image",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(22.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                    .heightIn(min = 24.dp, max = 120.dp),
            ) {
                if (displayText.isEmpty()) {
                    Text(
                        placeholder,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                BasicTextField(
                    value = displayText,
                    onValueChange = {
                        // Manual edits while dictating fold the transcript in.
                        if (dictation.active) Dictation.cancel()
                        draft = it
                        onTextChange(it)
                    },
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            IconButton(
                onClick = {
                    if (dictation.active) {
                        Dictation.stop() // commit lands via Dictation.committed
                    } else {
                        val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                            PackageManager.PERMISSION_GRANTED
                        if (granted) Dictation.start()
                        else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                },
                modifier = Modifier.size(40.dp),
            ) {
                Icon(
                    if (dictation.active) Icons.Filled.Stop else Icons.Filled.Mic,
                    contentDescription = if (dictation.active) "Stop dictation" else "Dictate",
                    tint = if (dictation.active) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
            IconButton(
                onClick = {
                    val text = displayText.trim()
                    if (dictation.active) Dictation.cancel()
                    if (text.isNotEmpty() || attachments.isNotEmpty()) {
                        val toSend = attachments
                        draft = ""
                        io.amar.console.core.DraftStore.put(context, draftKey, "")
                        attachments = emptyList()
                        onTextChange("")
                        if (onSendWithAttachments != null && toSend.isNotEmpty()) {
                            onSendWithAttachments(text, toSend)
                        } else {
                            onSend(text)
                        }
                    }
                },
                enabled = canSend,
                colors = IconButtonDefaults.iconButtonColors(
                    containerColor = if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                ),
                modifier = Modifier.size(44.dp).clip(CircleShape),
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** All image content:// URIs currently on the clipboard (FEATURES chat #8:
 *  "paste attaches ALL clipboard images"). Reads every ClipData item, keeping
 *  those whose URI resolves to an image mime type. */
private fun clipboardImageUris(context: android.content.Context): List<Uri> {
    val cm = context.getSystemService(android.content.ClipboardManager::class.java) ?: return emptyList()
    val clip = cm.primaryClip ?: return emptyList()
    val out = mutableListOf<Uri>()
    for (i in 0 until clip.itemCount) {
        val uri = clip.getItemAt(i)?.uri ?: continue
        val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
        if (mime?.startsWith("image/") == true) out.add(uri)
    }
    return out
}
