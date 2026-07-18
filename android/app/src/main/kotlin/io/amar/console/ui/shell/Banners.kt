package io.amar.console.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.FilterChip
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import io.amar.console.ui.nav.Pane

@Composable
fun StatusBanner(text: String, tint: Color, icon: ImageVector? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        icon?.let { Icon(it, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp)) }
        Text(text, style = MaterialTheme.typography.labelMedium, color = tint)
    }
}

@Composable
fun UpdateBanner(versionName: String, onInstall: () -> Unit, onDismiss: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (versionName.isNotEmpty()) "Update available ($versionName)" else "Update available",
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onInstall) { Text("Install") }
        TextButton(onClick = onDismiss) { Text("×") }
    }
}

@Composable
fun OverflowRow(onSelect: (Pane) -> Unit, onSettings: () -> Unit, onMusic: () -> Unit = {}, onHardware: () -> Unit = {}) {
    LazyRow(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(Pane.overflow) { pane ->
            FilterChip(
                selected = false,
                onClick = { onSelect(pane) },
                label = { Text(pane.label) },
                leadingIcon = { Icon(pane.icon, contentDescription = null, modifier = Modifier.size(16.dp)) },
            )
        }
        item {
            FilterChip(
                selected = false,
                onClick = onMusic,
                label = { Text("Music") },
            )
        }
        item {
            FilterChip(
                selected = false,
                onClick = onHardware,
                label = { Text("Glasses/Pen") },
            )
        }
        item {
            FilterChip(
                selected = false,
                onClick = onSettings,
                label = { Text("Settings") },
            )
        }
    }
}
