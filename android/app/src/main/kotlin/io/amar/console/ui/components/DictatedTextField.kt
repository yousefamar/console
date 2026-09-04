package io.amar.console.ui.components

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import io.amar.console.core.Dictation
import java.util.UUID

/**
 * A single-line OutlinedTextField with its own dictation mic. The dictation
 * is OWNED by this field ([Dictation.start] with a unique owner id), so the
 * live transcript renders here and the commit lands in [onValueChange] —
 * never in an on-screen [Composer], which ignores owned dictations. Several
 * fields can coexist; tapping one's mic takes the mic over from whoever had
 * it. Used by the approval card's answer + plan-comment fields.
 */
@Composable
fun DictatedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val owner = remember { "field-" + UUID.randomUUID() }
    val dictation by Dictation.state.collectAsState()
    val mine = dictation.active && dictation.owner == owner
    val display = if (mine && dictation.transcript.isNotEmpty()) {
        (value.trimEnd() + " " + dictation.transcript).trim()
    } else value
    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) Dictation.start(owner) }
    // The field leaving the screen mid-dictation must release the mic.
    DisposableEffect(owner) {
        onDispose { if (Dictation.state.value.owner == owner) Dictation.cancel() }
    }

    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = display,
            // A manual edit while dictating folds the transcript in (the
            // displayed text IS the new value) and ends the dictation.
            onValueChange = { if (mine) Dictation.cancel(); onValueChange(it) },
            placeholder = { Text(if (mine) "Listening…" else placeholder, style = MaterialTheme.typography.bodySmall) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.weight(1f),
            textStyle = MaterialTheme.typography.bodySmall,
            singleLine = true,
        )
        IconButton(
            onClick = {
                if (mine) {
                    Dictation.stop { text ->
                        if (text.isNotEmpty()) onValueChange((value.trimEnd() + " " + text).trim())
                    }
                } else {
                    if (dictation.active) Dictation.cancel()
                    val granted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED
                    if (granted) Dictation.start(owner) else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            },
            modifier = Modifier.size(40.dp),
        ) {
            Icon(
                if (mine) Icons.Filled.Stop else Icons.Filled.Mic,
                contentDescription = if (mine) "Stop dictation" else "Dictate",
                tint = if (mine) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}
