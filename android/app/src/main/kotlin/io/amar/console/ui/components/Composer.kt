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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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

/**
 * WhatsApp-style composer: pill input (grows to 5 lines), attach button
 * (system picker, any file type), dictation mic (hub /stt, live transcript
 * appears in the input), filled round send button. Draft survives rotation.
 *
 * [onSendWithAttachments] receives (text, uris) — text may be empty when
 * only attachments are sent. When null, attach UI is hidden (plain text
 * composer, e.g. agents until image prompts land).
 */
@Composable
fun Composer(
    placeholder: String,
    draftKey: String,
    onSend: (String) -> Unit,
    onTextChange: (String) -> Unit = {},
    onSendWithAttachments: ((String, List<Uri>) -> Unit)? = null,
) {
    var draft by rememberSaveable(draftKey) { mutableStateOf("") }
    var attachments by remember(draftKey) { mutableStateOf<List<Uri>>(emptyList()) }
    val dictation by Dictation.state.collectAsState()
    val context = LocalContext.current

    // While dictating, the live transcript renders appended to the draft.
    val displayText = if (dictation.active && dictation.transcript.isNotEmpty()) {
        (draft.trimEnd() + " " + dictation.transcript).trim()
    } else draft
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
                    Box {
                        AsyncImage(
                            model = uri,
                            contentDescription = null,
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
                        Dictation.stop { text ->
                            if (text.isNotEmpty()) {
                                draft = (draft.trimEnd() + " " + text).trim()
                                onTextChange(draft)
                            }
                        }
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
