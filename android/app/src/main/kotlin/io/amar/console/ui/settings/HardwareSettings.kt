package io.amar.console.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.amar.console.ConsoleApp
import io.amar.console.glasses.GlassesController
import io.amar.console.glasses.GlassesState
import io.amar.console.pen.PenController
import io.amar.console.pen.PenState

/**
 * Glasses + pen settings — Compose replacement for the SPA's
 * GlassesSettings.tsx / PenSettings.tsx bridge UI. State comes straight
 * from the native singletons (no JS bridge — this got SIMPLER).
 */
@Composable
fun HardwareSettingsScreen(app: ConsoleApp) {
    var glassesJson by remember { mutableStateOf(GlassesState.toJson().toString(2)) }
    var penJson by remember { mutableStateOf(PenState.toJson().toString(2)) }

    DisposableEffect(Unit) {
        val gl = { glassesJson = GlassesState.toJson().toString(2) }
        val pl = { penJson = PenState.toJson().toString(2) }
        GlassesState.addListener(gl)
        PenState.addListener(pl)
        onDispose {
            GlassesState.removeListener(gl)
            PenState.removeListener(pl)
        }
    }

    val mirrorEnabled by app.graph.mirror.enabledFlow.collectAsState()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Glasses", style = MaterialTheme.typography.titleMedium)
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Mirror current pane to lenses", style = MaterialTheme.typography.bodyMedium)
            Switch(
                checked = mirrorEnabled,
                onCheckedChange = { app.graph.mirror.setEnabled(it) },
            )
        }
        Text(
            "Mirror dims the phone screen (stealth) — the Activity stays live so keystrokes flow.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { if (GlassesController.isReady()) GlassesController.scan() }) { Text("Scan") }
            OutlinedButton(onClick = { if (GlassesController.isReady()) GlassesController.requireBle().reconnect() }) { Text("Reconnect") }
            OutlinedButton(onClick = { if (GlassesController.isReady()) GlassesController.requireBle().disconnect() }) { Text("Disconnect") }
        }
        Text(
            glassesJson,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        HorizontalDivider()

        Text("Pen", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { if (PenController.isReady()) PenController.startScan() }) { Text("Scan") }
            OutlinedButton(onClick = { if (PenController.isReady()) PenController.connect(null) }) { Text("Connect") }
            OutlinedButton(onClick = { if (PenController.isReady()) PenController.disconnect() }) { Text("Disconnect") }
        }
        Text(
            penJson,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
