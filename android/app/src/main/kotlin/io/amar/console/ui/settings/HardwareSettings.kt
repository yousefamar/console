package io.amar.console.ui.settings

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.amar.console.ConsoleApp
import io.amar.console.data.longtail.GLASSES_CHANNELS
import io.amar.console.data.longtail.GlassesHubConfig
import io.amar.console.data.longtail.MicStatus
import io.amar.console.glasses.GlassesController
import io.amar.console.glasses.GlassesState
import io.amar.console.pen.PenController
import io.amar.console.pen.PenState
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Glasses + pen + mic settings — Compose replacement for the SPA's
 * GlassesSettings.tsx / PenSettings.tsx bridge UI. Device state comes
 * straight from the native singletons; notify/HUD config + pen live-stream
 * are hub-side (GET/POST /glasses/config, /pen/stream) so they match desktop.
 */
@Composable
fun HardwareSettingsScreen(app: ConsoleApp, onBack: () -> Unit = {}) {
    // Native state ticks — re-serialize the singletons on every change.
    var glassesTick by remember { mutableStateOf(0) }
    var penTick by remember { mutableStateOf(0) }
    DisposableEffect(Unit) {
        val gl: () -> Unit = { glassesTick++ }
        val pl: () -> Unit = { penTick++ }
        GlassesState.addListener(gl)
        PenState.addListener(pl)
        onDispose {
            GlassesState.removeListener(gl)
            PenState.removeListener(pl)
        }
    }

    val scope = rememberCoroutineScope()
    val mirrorEnabled by app.graph.mirror.enabledFlow.collectAsState()

    // Hub-side config (online-only; null = not loaded / hub unreachable).
    var config by remember { mutableStateOf<GlassesHubConfig?>(null) }
    var penStreaming by remember { mutableStateOf<Boolean?>(null) }
    var mic by remember { mutableStateOf<MicStatus?>(null) }
    LaunchedEffect(Unit) {
        config = app.graph.hardware.getGlassesConfig()
        penStreaming = app.graph.hardware.getPenStream()
        // Mic/PTT polled while this screen is visible.
        while (true) {
            mic = app.graph.hardware.micStatus()
            kotlinx.coroutines.delay(5000)
        }
    }

    var confirmUnpair by remember { mutableStateOf(false) }
    var scanRequested by remember { mutableStateOf(false) }
    var pinInput by remember { mutableStateOf("") }
    var angle by remember { mutableStateOf<Float?>(null) }

    Column(Modifier.fillMaxSize()) {
    io.amar.console.ui.components.PaneTopBar(
        title = "Hardware",
        subtitle = "Glasses · Pen · PTT",
        onBack = onBack,
    )
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // ------------------------------------------------------------ //
        // Glasses
        Text("Glasses", style = MaterialTheme.typography.titleMedium)

        // Formatted status rows (tick forces re-read of the singleton).
        @Suppress("UNUSED_EXPRESSION") glassesTick
        val connected = GlassesState.connected
        StatusRow("State", when {
            connected -> "connected"
            GlassesState.leftStatus == GlassesState.ArmStatus.CONNECTING ||
                GlassesState.rightStatus == GlassesState.ArmStatus.CONNECTING -> "connecting…"
            GlassesState.leftMac != null -> "paired, disconnected"
            else -> "unpaired"
        })
        StatusRow(
            "Battery L / R",
            "${GlassesState.batteryLeft?.let { "$it%" } ?: "—"} / ${GlassesState.batteryRight?.let { "$it%" } ?: "—"}",
        )
        StatusRow("Worn", GlassesState.worn?.let { if (it) "yes" else "no" } ?: "—")
        StatusRow(
            "Case",
            buildString {
                append(GlassesState.caseBattery?.let { "$it%" } ?: "—")
                if (GlassesState.caseCharging == true) append(" · charging")
            },
        )
        StatusRow("Channel", GlassesState.channel ?: "—")
        GlassesState.lastError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                if (GlassesController.isReady()) {
                    scanRequested = true
                    GlassesController.scan()
                }
            }) { Text("Scan") }
            OutlinedButton(
                onClick = { if (GlassesController.isReady()) GlassesController.sendText("Console test ✓") },
                enabled = connected,
            ) { Text("Test display") }
            if (GlassesState.leftMac != null) {
                OutlinedButton(onClick = { confirmUnpair = true }) { Text("Unpair") }
            }
        }

        // Scan candidates — tappable list → pair.
        if (scanRequested) {
            val candidates = remember(glassesTick) {
                val arr = GlassesState.scanCandidatesJson()
                (0 until arr.length()).map { arr.getJSONObject(it) }
            }
            if (candidates.isEmpty()) {
                Text(
                    "Scanning… no pairs found yet",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            for (c in candidates) {
                ScanCandidateRow(c) { left, right, channel ->
                    if (GlassesController.isReady()) {
                        GlassesController.pair(left, right, channel)
                        scanRequested = false
                    }
                }
            }
        }

        // Hub-side notify + HUD config.
        config?.let { cfg ->
            HorizontalDivider()
            ToggleRow("Forward notifications to lenses", cfg.notifyEnabled) { v ->
                scope.launch { app.graph.hardware.setNotifyEnabled(v)?.let { config = it } }
            }
            if (cfg.notifyEnabled) {
                for (channel in GLASSES_CHANNELS) {
                    ToggleRow("    $channel", cfg.channels[channel] ?: true) { v ->
                        scope.launch { app.graph.hardware.setChannel(channel, v)?.let { config = it } }
                    }
                }
            }
            ToggleRow("Head-up HUD", cfg.hudEnabled) { v ->
                scope.launch { app.graph.hardware.setHudEnabled(v)?.let { config = it } }
            }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Head-up angle", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "${(angle ?: cfg.headUpAngleDeg.toFloat()).toInt()}°",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Slider(
                value = angle ?: cfg.headUpAngleDeg.toFloat(),
                onValueChange = { angle = it },
                onValueChangeFinished = {
                    val deg = (angle ?: return@Slider).toInt()
                    scope.launch { app.graph.hardware.setHeadUpAngle(deg)?.let { config = it } }
                    angle = null
                },
                valueRange = 0f..60f,
                modifier = Modifier.fillMaxWidth(),
            )
        } ?: Text(
            "Hub config unavailable (offline?)",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        ToggleRow("Mirror current pane to lenses", mirrorEnabled) { app.graph.mirror.setEnabled(it) }
        Text(
            "Mirror dims the phone screen (stealth) — the Activity stays live so keystrokes flow.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        HorizontalDivider()

        // ------------------------------------------------------------ //
        // Pen
        Text("Pen", style = MaterialTheme.typography.titleMedium)
        @Suppress("UNUSED_EXPRESSION") penTick
        StatusRow("State", PenState.status.name.lowercase())
        StatusRow("Battery", PenState.battery?.let { "$it%" } ?: "—")
        StatusRow("Storage used", PenState.usedMemPct?.let { "$it%" } ?: "—")
        StatusRow("Authorized", if (PenState.authorized) "yes" else if (PenState.locked) "locked" else "—")
        PenState.lastError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }

        if (PenState.locked && !PenState.authorized) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = pinInput,
                    onValueChange = { pinInput = it.filter(Char::isDigit).take(8) },
                    label = { Text("Unlock PIN") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        if (PenController.isReady() && pinInput.isNotEmpty()) {
                            PenController.sendPassword(pinInput)
                            pinInput = ""
                        }
                    },
                    enabled = pinInput.isNotEmpty(),
                ) { Text("Unlock") }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { if (PenController.isReady()) PenController.startScan() }) { Text("Scan") }
            OutlinedButton(onClick = { if (PenController.isReady()) PenController.connect(null) }) { Text("Connect") }
            OutlinedButton(onClick = { if (PenController.isReady()) PenController.disconnect() }) { Text("Disconnect") }
        }

        penStreaming?.let { streaming ->
            ToggleRow("Live-stream strokes → Notes", streaming) { v ->
                scope.launch { app.graph.hardware.setPenStream(v)?.let { penStreaming = it } }
            }
        }

        HorizontalDivider()

        // ------------------------------------------------------------ //
        // Mic / PTT
        Text("Mic / PTT", style = MaterialTheme.typography.titleMedium)
        StatusRow("Owner", mic?.ownerName ?: "—")
        StatusRow("Recording", if (mic?.hot == true) "● live" else "idle")
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair glasses?") },
            text = { Text("Drops the stored MACs — you'll need to scan + pair again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    if (GlassesController.isReady()) GlassesController.unpair()
                }) { Text("Unpair", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
    }
}

@Composable
private fun StatusRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun ScanCandidateRow(c: JSONObject, onPair: (String, String, String) -> Unit) {
    val channel = c.optString("channel", "?")
    val left = c.optString("leftMac").takeIf { it.isNotEmpty() && it != "null" }
    val right = c.optString("rightMac").takeIf { it.isNotEmpty() && it != "null" }
    val ready = c.optBoolean("ready", false)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = ready) {
                if (left != null && right != null) onPair(left, right, channel)
            }
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text("G1 channel $channel", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(
                "L ${left ?: "…"} · R ${right ?: "…"}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            if (ready) "Tap to pair" else "waiting for both arms",
            style = MaterialTheme.typography.labelSmall,
            color = if (ready) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
