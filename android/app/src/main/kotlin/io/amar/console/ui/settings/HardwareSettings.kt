package io.amar.console.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import io.amar.console.glasses.GlassesEvents
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
    var eventsTick by remember { mutableStateOf(0) }
    DisposableEffect(Unit) {
        val gl: () -> Unit = { glassesTick++ }
        val pl: () -> Unit = { penTick++ }
        val ev: () -> Unit = { eventsTick++ }
        GlassesState.addListener(gl)
        PenState.addListener(pl)
        GlassesEvents.addRingListener(ev)
        onDispose {
            GlassesState.removeListener(gl)
            PenState.removeListener(pl)
            GlassesEvents.removeRingListener(ev)
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
    var pairOpen by remember { mutableStateOf(false) }
    var eventsOpen by remember { mutableStateOf(false) }
    var testOpen by remember { mutableStateOf(false) }
    var testText by remember { mutableStateOf("Hello from Console") }
    var testNotifyState by remember { mutableStateOf("idle") } // idle | sending | sent | error
    var pinInput by remember { mutableStateOf("") }
    var penPairOpen by remember { mutableStateOf(false) }
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
        val pairing = GlassesState.leftStatus == GlassesState.ArmStatus.CONNECTING ||
            GlassesState.rightStatus == GlassesState.ArmStatus.CONNECTING
        val paired = GlassesState.leftMac != null
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(
                when {
                    connected -> "G1 connected"
                    pairing -> "Connecting…"
                    paired -> "G1 disconnected"
                    else -> "No glasses paired"
                },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            // Connected → Pause (disconnect, keep pairing) + Unpair.
            // Paired-but-disconnected → Connect (reconnect saved pair, no scan).
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    connected -> {
                        TextButton(onClick = { if (GlassesController.isReady()) GlassesController.disconnect() }) {
                            Text("Pause")
                        }
                        TextButton(onClick = { confirmUnpair = true }) {
                            Text("Unpair", color = MaterialTheme.colorScheme.error)
                        }
                    }
                    paired -> Button(
                        onClick = { if (GlassesController.isReady()) GlassesController.reconnect() },
                        enabled = !pairing,
                    ) { Text(if (pairing) "Connecting…" else "Connect") }
                    else -> Text(
                        "not paired",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        if (connected) {
            StatusRow(
                "Battery L / R",
                buildString {
                    append(GlassesState.batteryLeft?.let { "$it%" } ?: "…")
                    append(" / ")
                    append(GlassesState.batteryRight?.let { "$it%" } ?: "…")
                    GlassesState.worn?.let { append(if (it) " · on head" else " · off head") }
                    GlassesState.channel?.let { append(" · ch $it") }
                },
            )
        }
        // Charging-case line — shown when paired even if arms not connected.
        if (paired && (GlassesState.caseBattery != null || GlassesState.caseCharging != null)) {
            StatusRow(
                "Case",
                buildString {
                    append(GlassesState.caseBattery?.let { "$it%" } ?: "—")
                    if (GlassesState.caseCharging == true) append(" · charging")
                },
            )
        }
        GlassesState.lastError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, maxLines = 2)
        }

        // Pair new / different glasses — disclosure that starts/stops the scan.
        if (!connected) {
            OutlinedButton(onClick = {
                val next = !pairOpen
                pairOpen = next
                if (next && GlassesController.isReady()) GlassesController.scan()
                else if (!next && GlassesController.isReady()) GlassesController.stopScan()
            }) {
                Text(
                    when {
                        pairOpen -> "Re-scan"
                        paired -> "Pair different glasses"
                        else -> "Pair new glasses"
                    },
                )
            }
            if (pairOpen) {
                val candidates = remember(glassesTick) {
                    val arr = GlassesState.scanCandidatesJson()
                    (0 until arr.length()).map { arr.getJSONObject(it) }
                }
                if (candidates.isEmpty()) {
                    Text(
                        "Scanning… wake the glasses (open + put on).",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                for (c in candidates) {
                    ScanCandidateRow(c) { left, right, channel ->
                        if (GlassesController.isReady()) {
                            GlassesController.pair(left, right, channel)
                            pairOpen = false
                        }
                    }
                }
            }
        }

        // App-wide mirror (only meaningful while connected, but the toggle is
        // always safe — it no-ops the BLE write when not ready).
        ToggleRow("Mirror current pane to lenses", mirrorEnabled) { app.graph.mirror.setEnabled(it) }
        Text(
            "Mirror dims the phone screen (stealth) — the Activity stays live so keystrokes flow.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Hub-side notify + HUD config.
        config?.let { cfg ->
            HorizontalDivider()
            ToggleRow("Notifications to glasses", cfg.notifyEnabled) { v ->
                scope.launch { app.graph.hardware.setNotifyEnabled(v)?.let { config = it } }
            }
            if (cfg.notifyEnabled) {
                for (channel in GLASSES_CHANNELS) {
                    ToggleRow("    ${channelLabel(channel)}", cfg.channels[channel] ?: true) { v ->
                        scope.launch { app.graph.hardware.setChannel(channel, v)?.let { config = it } }
                    }
                }
            }
            ToggleRow("HUD on head-tilt", cfg.hudEnabled) { v ->
                scope.launch { app.graph.hardware.setHudEnabled(v)?.let { config = it } }
            }
            if (cfg.hudEnabled) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Tilt angle", style = MaterialTheme.typography.bodyMedium)
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
                    // 10–60° step 5 (matches the SPA slider).
                    valueRange = 10f..60f,
                    steps = 9,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        } ?: Text(
            "Hub config unavailable (offline?)",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Recent events diagnostic panel — raw 0xF5 subcmds, newest first.
        // Available even when disconnected (subscribes to the ring only here).
        HorizontalDivider()
        OutlinedButton(onClick = { eventsOpen = !eventsOpen }) {
            Text(if (eventsOpen) "Hide recent events" else "Recent events")
        }
        if (eventsOpen) {
            @Suppress("UNUSED_EXPRESSION") eventsTick
            val events = remember(eventsTick) { GlassesEvents.recent() }
            if (events.isEmpty()) {
                Text(
                    "No events yet — tap a touchbar or tilt your head.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Column(
                    Modifier.heightIn(max = 160.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    for (e in events.asReversed()) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                if (e.arm == io.amar.console.glasses.G1Protocol.Arm.LEFT) "L" else "R",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                "0x${e.subcmd.toString(16).padStart(2, '0')}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(GlassesEvents.classify(e.subcmd).label(), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }

        // Dev affordance: free-text test display + clear + test notification.
        if (connected) {
            OutlinedButton(onClick = { testOpen = !testOpen }) {
                Text(if (testOpen) "Hide test display" else "Test display")
            }
            if (testOpen) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = testText,
                        onValueChange = { testText = it },
                        label = { Text("Text to show on G1") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(onClick = { if (GlassesController.isReady()) GlassesController.sendText(testText) }) { Text("Send") }
                    OutlinedButton(onClick = { if (GlassesController.isReady()) GlassesController.clear() }) { Text("clr") }
                }
                // Fire a real push through POST /push/send exercising the full pipeline.
                OutlinedButton(
                    onClick = {
                        testNotifyState = "sending"
                        scope.launch {
                            testNotifyState = if (app.graph.hardware.sendTestNotification()) "sent" else "error"
                        }
                    },
                    enabled = testNotifyState != "sending",
                ) {
                    Text(
                        when (testNotifyState) {
                            "sending" -> "Sending…"
                            "sent" -> "Sent ✓"
                            "error" -> "Failed"
                            else -> "Test notification"
                        },
                    )
                }
            }
        }

        HorizontalDivider()

        // ------------------------------------------------------------ //
        // Pen
        Text("Pen", style = MaterialTheme.typography.titleMedium)
        @Suppress("UNUSED_EXPRESSION") penTick
        val penConnected = PenState.status == PenState.Status.CONNECTED
        val penConnecting = PenState.status == PenState.Status.CONNECTING
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(
                when {
                    penConnected -> "${PenState.name ?: "Pen"} connected" +
                        (PenState.firmware?.let { " · fw $it" } ?: "")
                    penConnecting -> "Connecting…"
                    else -> "No pen connected"
                },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            if (penConnected) {
                TextButton(onClick = { if (PenController.isReady()) PenController.disconnect() }) { Text("Disconnect") }
            } else {
                Button(
                    onClick = { if (PenController.isReady()) PenController.connect(null) },
                    enabled = !penConnecting,
                ) { Text(if (penConnecting) "Connecting…" else "Connect") }
            }
        }

        if (penConnected) {
            StatusRow("Battery", PenState.battery?.let { "$it%" } ?: "…")
            StatusRow("Storage used", PenState.usedMemPct?.let { "$it%" } ?: "…")
            PenState.offlineSaveOn?.let { StatusRow("Offline save", if (it) "on" else "off") }
            // Live dot readout (updates as the pen writes — "first light").
            if (PenState.lastDotX != null || PenState.lastDotY != null) {
                StatusRow("Last dot", "(${PenState.lastDotX ?: "–"}, ${PenState.lastDotY ?: "–"})")
            }
        }
        PenState.lastError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, maxLines = 2)
        }

        // Unlock — only while locked + unauthorized.
        if (penConnected && PenState.locked && !PenState.authorized) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = pinInput,
                    onValueChange = { pinInput = it.filter(Char::isDigit).take(8) },
                    label = { Text("Pen password") },
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

        // Live-stream strokes → Notes (hub-side toggle).
        penStreaming?.let { streaming ->
            ToggleRow("Live-stream strokes → Notes", streaming) { v ->
                scope.launch { app.graph.hardware.setPenStream(v)?.let { penStreaming = it } }
            }
        }

        // Pair a new pen — disclosure listing up to 6 BLE observations,
        // tap-to-connect a specific MAC. Only while disconnected.
        if (!penConnected) {
            OutlinedButton(onClick = {
                val next = !penPairOpen
                penPairOpen = next
                if (next && PenController.isReady()) PenController.startScan()
                else if (!next && PenController.isReady()) PenController.stopScan()
            }) {
                Text(if (penPairOpen) (if (PenState.scanning) "Scanning…" else "Re-scan") else "Pair a new pen")
            }
            if (penPairOpen) {
                val observations = remember(penTick) { PenState.scanObservationsList().take(6) }
                if (observations.isEmpty()) {
                    Text(
                        if (PenState.scanning) "Scanning… make a mark with the pen to wake it." else "No pens found.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                for (o in observations) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { if (PenController.isReady()) { PenController.connect(o.mac); penPairOpen = false } }
                            .padding(vertical = 6.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            o.name.ifBlank { "Smart Pen" },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            "${shortMac(o.mac)} · ${o.rssi}dBm",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
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
            title = { Text("Forget glasses?") },
            text = { Text("Drops the stored MACs — you'll need to scan + pair again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    if (GlassesController.isReady()) GlassesController.unpair()
                }) { Text("Forget", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
    }
}

/** Human label for a notify channel key (matches the SPA NOTIFY_CHANNELS). */
private fun channelLabel(key: String): String = when (key) {
    "mail" -> "Mail"
    "chat" -> "Chat"
    "calendar" -> "Calendar"
    "agent" -> "Agents"
    "money" -> "Money"
    else -> "Other"
}

/** Trim a BLE MAC to its last two octets for a compact label. */
private fun shortMac(mac: String): String {
    val parts = mac.split(':')
    return if (parts.size > 2) parts.takeLast(2).joinToString(":") else mac
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
    val rssi = if (c.isNull("rssi")) null else c.optInt("rssi")
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
            Text(
                buildString {
                    append("G1 #$channel")
                    if (!ready) append(" (need both arms)")
                    rssi?.let { append(" · $it dBm") }
                },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Text(
                "L ${left ?: "…"} · R ${right ?: "…"}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            if (ready) "Tap to pair" else "waiting",
            style = MaterialTheme.typography.labelSmall,
            color = if (ready) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
