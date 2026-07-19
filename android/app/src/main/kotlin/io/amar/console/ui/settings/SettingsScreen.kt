package io.amar.console.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.amar.console.BuildConfig
import io.amar.console.ConsoleApp
import io.amar.console.HubTokenStore
import io.amar.console.PushService
import io.amar.console.core.HubConfig
import io.amar.console.core.Updater
import kotlinx.coroutines.launch

/**
 * Settings: hub pairing (URL + bearer token), update check, version info.
 * Glasses/pen settings screens land in M6.
 */
@Composable
fun SettingsScreen(app: ConsoleApp) {
    val scope = rememberCoroutineScope()
    var hubUrl by remember { mutableStateOf(HubConfig.hubBase) }
    var token by remember { mutableStateOf("") }
    var hasToken by remember { mutableStateOf(HubTokenStore.get() != null) }
    var status by remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Hub pairing", style = MaterialTheme.typography.titleMedium)
        Text(
            if (hasToken) "Paired — bearer token stored." else "Not paired. Mint an apk-scope token from the desktop SPA (Account → Pair this APK) and paste it here.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = hubUrl,
            onValueChange = { hubUrl = it },
            label = { Text("Hub URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Bearer token") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = {
                HubConfig.setHubBase(hubUrl.ifBlank { HubConfig.DEFAULT_BASE })
                if (token.isNotBlank()) {
                    HubTokenStore.set(token.trim())
                    token = ""
                    hasToken = true
                }
                PushService.kick(app)
                app.graph.syncBus.stop()
                app.graph.syncBus.start()
                status = "Saved. Reconnecting…"
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save & reconnect") }
        if (hasToken) {
            OutlinedButton(
                onClick = {
                    HubTokenStore.clear()
                    hasToken = false
                    PushService.kick(app)
                    status = "Token cleared."
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Clear token") }
        }
        if (status.isNotEmpty()) {
            Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }

        HorizontalDivider()

        Text("Notifications", style = MaterialTheme.typography.titleMedium)
        val hubPrefs by io.amar.console.core.HubPrefs.prefs.collectAsState()
        val dnd = (hubPrefs["dnd"] as? kotlinx.serialization.json.JsonPrimitive)
            ?.content == "true"
        androidx.compose.foundation.layout.Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Do Not Disturb", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Synced across devices (hub pref)",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            androidx.compose.material3.Switch(
                checked = dnd,
                onCheckedChange = { enabled ->
                    scope.launch { io.amar.console.core.HubPrefs.setDnd(app.graph.hub, enabled) }
                },
            )
        }

        HorizontalDivider()

        Text("App", style = MaterialTheme.typography.titleMedium)
        Text(
            "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(
            onClick = { scope.launch { Updater.check(); status = "Checked for updates." } },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Check for updates") }
    }
}
