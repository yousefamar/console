package io.amar.console.ui.agents

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.amar.console.ui.components.Composer
import io.amar.console.ui.components.ComposerHandle

/**
 * Agent composer = the shared [Composer] plus slash-command autocomplete. When
 * the draft starts with '/', a filtered list of the session's slash commands
 * renders above the input; tapping one completes to '/cmd '. Ported from
 * AgentPromptInput.tsx's slash menu (mobile: tap-to-complete, no arrow keys).
 */
@Composable
fun AgentComposer(
    placeholder: String,
    draftKey: String,
    slashCommands: List<String>,
    handle: ComposerHandle,
    onSend: (String) -> Unit,
    onTextChange: (String) -> Unit = {},
    onSendWithAttachments: ((String, List<Uri>) -> Unit)? = null,
) {
    var draft by remember(draftKey) { mutableStateOf("") }

    val matches = remember(draft, slashCommands) {
        val t = draft
        if (!t.startsWith("/") || t.contains(" ") || t.length < 1) emptyList()
        else {
            val q = t.drop(1).lowercase()
            slashCommands.filter { it.lowercase().startsWith(q) }.take(8)
        }
    }

    Composer(
        placeholder = placeholder,
        draftKey = draftKey,
        handle = handle,
        onSend = onSend,
        onTextChange = { draft = it; onTextChange(it) },
        onSendWithAttachments = onSendWithAttachments,
        aboveInput = if (matches.isNotEmpty()) {
            {
                LazyColumn(
                    Modifier.fillMaxWidth().heightIn(max = 180.dp).padding(horizontal = 8.dp),
                ) {
                    items(matches) { cmd ->
                        Text(
                            "/$cmd",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { handle.setText("/$cmd "); draft = "/$cmd " }
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        } else null,
    )
}
