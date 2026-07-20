package io.amar.console.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.amar.console.BuildConfig
import io.amar.console.ConsoleApp
import io.amar.console.HubTokenStore
import io.amar.console.PushService
import io.amar.console.core.HubConfig
import io.amar.console.core.Updater
import io.amar.console.data.longtail.MatrixStatus
import kotlinx.coroutines.launch

/**
 * Settings: account management (Gmail + Matrix), hub pairing (URL + bearer
 * token), DND, update check, version + build-age. Mirrors the SPA's
 * AccountModal + ApkPairSection.
 */
@Composable
fun SettingsScreen(app: ConsoleApp, onGrid: () -> Unit = {}, onHardware: () -> Unit = {}, onOutbox: () -> Unit = {}) {
    val scope = rememberCoroutineScope()
    var hubUrl by remember { mutableStateOf(HubConfig.hubBase) }
    var token by remember { mutableStateOf("") }
    var hasToken by remember { mutableStateOf(HubTokenStore.get() != null) }
    var status by remember { mutableStateOf("") }
    var pairing by remember { mutableStateOf(false) }
    var pairError by remember { mutableStateOf<String?>(null) }

    // Account state (hub-side; refreshed on mount).
    var gmailEmail by remember { mutableStateOf("") }
    var matrix by remember { mutableStateOf<MatrixStatus?>(null) }
    var signingOut by remember { mutableStateOf<String?>(null) } // "gmail" | "matrix" | null
    var showMatrixLogin by remember { mutableStateOf(false) }

    suspend fun refreshAccounts() {
        gmailEmail = app.graph.hardware.googleEmail().ifBlank { app.graph.mail.userEmail() }
        matrix = app.graph.hardware.matrixStatus()
    }
    LaunchedEffect(Unit) { refreshAccounts() }

    Column(Modifier.fillMaxSize()) {
    io.amar.console.ui.components.PaneTopBar(title = "Settings", onGrid = onGrid)
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedButton(onClick = onHardware, modifier = Modifier.fillMaxWidth()) {
            Text("Glasses · Pen · PTT →")
        }

        HorizontalDivider()

        // ---- Accounts ---- //
        Text("Accounts", style = MaterialTheme.typography.titleMedium)

        // Gmail
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Gmail", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(gmailEmail.ifBlank { "Gmail" }, style = MaterialTheme.typography.bodyMedium)
            }
            TextButton(
                onClick = {
                    signingOut = "gmail"
                    scope.launch {
                        app.graph.hardware.signOutGoogle()
                        refreshAccounts()
                        signingOut = null
                        status = "Signed out of Gmail."
                    }
                },
                enabled = signingOut == null,
            ) { Text(if (signingOut == "gmail") "Signing out…" else "Sign out") }
        }

        // Matrix
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Matrix", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val m = matrix
                if (m?.connected == true) {
                    Text(m.userId ?: "Matrix", style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                } else {
                    Text("Not connected", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (matrix?.connected == true) {
                TextButton(
                    onClick = {
                        signingOut = "matrix"
                        scope.launch {
                            app.graph.hardware.matrixLogout()
                            // Clear the local chat cache (rooms + messages) so a
                            // reconnect doesn't show stale data (SPA parity:
                            // db.chatRooms.clear() + db.chatMessages.clear()).
                            runCatching {
                                app.graph.db.chatRooms().deleteAll()
                                app.graph.db.chatMessages().deleteAll()
                            }
                            refreshAccounts()
                            signingOut = null
                            status = "Matrix disconnected."
                        }
                    },
                    enabled = signingOut == null,
                ) { Text(if (signingOut == "matrix") "Disconnecting…" else "Disconnect") }
            } else {
                TextButton(onClick = { showMatrixLogin = true }) { Text("Connect") }
            }
        }

        HorizontalDivider()

        Text("Hub pairing", style = MaterialTheme.typography.titleMedium)
        Text(
            if (hasToken) "Paired — bearer token stored." else "Not paired. Mint an apk-scope token from the desktop SPA (Account → Pair this APK) and paste it here (or scan the pairing QR — console://pair deep link).",
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
                pairing = true
                pairError = null
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
                // Verify the token actually authenticates; surface a clear error
                // if the hub rejects it (SPA pairing busy/error states).
                scope.launch {
                    val ok = runCatching { app.graph.hardware.matrixStatus() != null || app.graph.hardware.googleEmail().isNotBlank() }.getOrDefault(false)
                    pairing = false
                    if (hasToken && !ok) {
                        pairError = "Couldn't reach the hub with that token — check the URL + token."
                    } else {
                        refreshAccounts()
                    }
                }
            },
            enabled = !pairing,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (pairing) "Pairing…" else "Save & reconnect") }
        pairError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        if (hasToken) {
            OutlinedButton(
                onClick = {
                    HubTokenStore.clear()
                    hasToken = false
                    PushService.kick(app)
                    status = "Token cleared."
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Unpair (clear token)") }
        }
        if (status.isNotEmpty()) {
            Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }

        HorizontalDivider()

        Text("Notifications", style = MaterialTheme.typography.titleMedium)
        val hubPrefs by io.amar.console.core.HubPrefs.prefs.collectAsState()
        val dnd = (hubPrefs["dnd"] as? kotlinx.serialization.json.JsonPrimitive)
            ?.content == "true"
        Row(
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
            Switch(
                checked = dnd,
                onCheckedChange = { enabled ->
                    scope.launch { io.amar.console.core.HubPrefs.setDnd(app.graph.hub, enabled) }
                },
            )
        }

        HorizontalDivider()

        // ---- Sync queue ---- //
        val backlog by app.graph.db.outbox().observeBacklogCount().collectAsState(initial = 0)
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Sync queue", style = MaterialTheme.typography.bodyMedium)
                Text(
                    if (backlog > 0) "$backlog pending / failed" else "All actions flushed",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (backlog > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onOutbox) { Text("View") }
        }

        HorizontalDivider()

        Text("App", style = MaterialTheme.typography.titleMedium)
        Text(
            "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // Build-age footer — from the APK's own install/update time.
        val buildAge = remember { formatBuildAge(app) }
        if (buildAge != null) {
            Text(
                "Built $buildAge",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        OutlinedButton(
            onClick = { scope.launch { Updater.check(); status = "Checked for updates." } },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Check for updates") }
    }
    }

    if (showMatrixLogin) {
        MatrixLoginDialog(
            onDismiss = { showMatrixLogin = false },
            onLogin = { homeserver, userId, password ->
                app.graph.hardware.matrixLogin(homeserver, userId, password).also { err ->
                    if (err == null) {
                        showMatrixLogin = false
                        refreshAccounts()
                        status = "Matrix connected."
                    }
                }
            },
        )
    }
}

/** Inline Matrix password-login dialog (the APK has no separate login screen). */
@Composable
private fun MatrixLoginDialog(
    onDismiss: () -> Unit,
    onLogin: suspend (homeserver: String, userId: String, password: String) -> String?,
) {
    val scope = rememberCoroutineScope()
    var homeserver by remember { mutableStateOf("https://matrix.beeper.com") }
    var userId by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Connect Matrix") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = homeserver, onValueChange = { homeserver = it },
                    label = { Text("Homeserver") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = userId, onValueChange = { userId = it },
                    label = { Text("User ID (@you:server)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password, onValueChange = { password = it },
                    label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                )
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        val err = onLogin(homeserver.trim(), userId.trim(), password)
                        busy = false
                        if (err != null) error = err
                    }
                },
                enabled = !busy && userId.isNotBlank() && password.isNotBlank(),
            ) { Text(if (busy) "Connecting…" else "Connect") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

/** "just now / Nm ago / Nh ago / Nd ago" from the APK's last-update time. */
private fun formatBuildAge(app: ConsoleApp): String? {
    val builtMs = runCatching {
        val pi = app.packageManager.getPackageInfo(app.packageName, 0)
        pi.lastUpdateTime
    }.getOrNull() ?: return null
    val diff = System.currentTimeMillis() - builtMs
    if (diff < 0) return null
    val mins = diff / 60_000
    val hours = mins / 60
    val days = hours / 24
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "${mins}m ago"
        hours < 24 -> "${hours}h ago"
        else -> "${days}d ago"
    }
}
