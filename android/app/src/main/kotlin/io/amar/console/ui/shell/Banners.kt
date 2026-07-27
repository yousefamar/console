package io.amar.console.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

@Composable
fun StatusBanner(text: String, tint: Color, icon: ImageVector? = null, onClick: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        icon?.let { Icon(it, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp)) }
        Text(text, style = MaterialTheme.typography.labelMedium, color = tint)
    }
}

/** Compact sync-status chip: an ICON (or 12dp spinner when icon is null) +
 *  optional short label ("3", "2h"), floating top-END so it hugs the corner
 *  instead of splitting the header. No sentences. Silence = live + fresh. */
@Composable
fun SyncStatusChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector?,
    tint: Color,
    label: String?,
    onClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    androidx.compose.material3.Surface(
        // Below the 52dp pane top bar: an overlay never reflows anything, but
        // top-aligned it would sit OVER the bar's action icons — this clears
        // them entirely while still hugging the corner.
        modifier = modifier.padding(top = 58.dp, end = 8.dp),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.85f),
        tonalElevation = 2.dp,
    ) {
        Row(
            Modifier
                .let { if (onClick != null) it.clickable(onClick = onClick) else it }
                .padding(horizontal = 7.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
            } else {
                androidx.compose.material3.CircularProgressIndicator(
                    modifier = Modifier.size(11.dp), strokeWidth = (1.5).dp, color = tint,
                )
            }
            if (label != null) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = tint)
            }
        }
    }
}

/** Floating status pill (overlay, never shifts layout): small rounded chip
 *  top-center, à la the SPA's subtle sync indicator. */
@Composable
fun StatusPill(text: String, tint: Color, onClick: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    androidx.compose.material3.Surface(
        modifier = modifier.padding(top = 6.dp),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.94f),
        tonalElevation = 3.dp,
        shadowElevation = 4.dp,
    ) {
        Row(
            Modifier
                .let { if (onClick != null) it.clickable(onClick = onClick) else it }
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(text, style = MaterialTheme.typography.labelSmall, color = tint)
        }
    }
}

/** Session-expired prompt: the bearer is dead (hub returned 401/403). Tapping
 *  "Re-pair" opens Settings where QR pairing lives. Amber (error-adjacent). */
@Composable
fun ReAuthBanner(onFix: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 12.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "Session expired — re-pair this device",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onFix) { Text("Re-pair") }
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
