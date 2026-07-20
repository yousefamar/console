package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import io.amar.console.data.cal.parseEventDetails
import io.amar.console.data.db.CalEventRow

/**
 * Working-location picker: Home, each known office label, a default "Office"
 * when none known, and a Custom-location text input. Chosen from the existing
 * working-location events (drives label list). Ports CalendarLocationPicker.tsx.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LocationPickerSheet(
    dayStartMs: Long,
    currentEvent: CalEventRow?,
    knownOffices: List<String>,
    onDismiss: () -> Unit,
    onPick: (type: String, label: String?) -> Unit,
) {
    var showCustom by remember { mutableStateOf(false) }
    var customLabel by remember { mutableStateOf("") }
    val current = currentEvent?.let { parseEventDetails(it.rawJson).workingLocation }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Outlined.LocationOn, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Working location", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(dayLabelShort(dayStartMs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            LocationRow(Icons.Filled.Home, "Home", current?.type == "homeOffice") { onPick("homeOffice", null) }

            if (knownOffices.isEmpty()) {
                LocationRow(Icons.Filled.Business, "Office", current?.type == "officeLocation") { onPick("officeLocation", "Office") }
            } else {
                for (office in knownOffices) {
                    LocationRow(
                        Icons.Filled.Business, office,
                        current?.type == "officeLocation" && current.label == office,
                    ) { onPick("officeLocation", office) }
                }
            }

            if (showCustom) {
                Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.LocationOn, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(6.dp))
                    OutlinedTextField(
                        value = customLabel, onValueChange = { customLabel = it },
                        placeholder = { Text("Custom location…") },
                        singleLine = true,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done,
                        ),
                        keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                            onDone = { if (customLabel.isNotBlank()) onPick("customLocation", customLabel.trim()) },
                        ),
                        modifier = Modifier.weight(1f),
                    )
                }
            } else {
                LocationRow(Icons.Outlined.LocationOn, "Custom location…", false) { showCustom = true }
            }
        }
    }
}

@Composable
private fun LocationRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (active) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f) else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}
