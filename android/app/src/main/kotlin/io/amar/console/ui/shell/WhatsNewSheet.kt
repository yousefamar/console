package io.amar.console.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.amar.console.BuildConfig
import io.amar.console.core.AppPrefs
import io.amar.console.core.Changelog
import io.amar.console.core.ChangelogVersion
import io.amar.console.core.Updater
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * One-slot request for the "What's new" sheet, which the shell hosts. Three
 * callers: the update banner (notes for the version on offer), the shell
 * itself once after an update, and Settings (the cached history).
 */
object WhatsNew {
    /** [install] = an update on offer, drawn as a button under the notes.
     *  [markSeen] = closing this counts as having read the installed version's notes. */
    data class Request(
        val versions: List<ChangelogVersion>,
        val install: Updater.Available? = null,
        val markSeen: Boolean = false,
    )

    private val _request = MutableStateFlow<Request?>(null)
    val request: StateFlow<Request?> = _request

    fun show(versions: List<ChangelogVersion>, install: Updater.Available? = null, markSeen: Boolean = false) {
        if (versions.isNotEmpty()) _request.value = Request(versions, install, markSeen)
    }

    fun dismiss() {
        val closing = _request.value
        _request.value = null
        if (closing?.markSeen == true) AppPrefs.setLastSeenVersion(BuildConfig.VERSION_CODE)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WhatsNewSheet(request: WhatsNew.Request, onInstall: (Updater.Available) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Text("What's new", style = MaterialTheme.typography.titleMedium)
            for (version in request.versions) {
                Text(
                    listOf("v${version.versionCode}", Changelog.dateLabel(version.date))
                        .filter { it.isNotEmpty() }.joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
                )
                for (item in version.items) {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 3.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "•",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(item, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    }
                }
            }
            request.install?.let { update ->
                Button(
                    onClick = { onInstall(update); onDismiss() },
                    modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                ) {
                    Text(if (update.versionName.isNotEmpty()) "Install ${update.versionName}" else "Install")
                }
            }
            Spacer(Modifier.size(28.dp))
        }
    }
}
