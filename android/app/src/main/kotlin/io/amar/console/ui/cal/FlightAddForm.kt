package io.amar.console.ui.cal

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val REGIONS = listOf(
    "europe" to "Europe", "asia" to "Asia", "north_america" to "N.America",
    "south_america" to "S.America", "africa" to "Africa", "oceania" to "Oceania",
)
private val DURATIONS = listOf("Weekend", "1 week", "2 weeks")
private val MONTHS = listOf(
    0 to "Next 6mo", 1 to "Jan", 2 to "Feb", 3 to "Mar", 4 to "Apr", 5 to "May", 6 to "Jun",
    7 to "Jul", 8 to "Aug", 9 to "Sep", 10 to "Oct", 11 to "Nov", 12 to "Dec",
)

/** New-watchlist form with Anywhere/Route kind toggle. */
@Composable
fun FlightAddForm(
    onCancel: () -> Unit,
    onCreate: (JsonObject) -> Unit,
) {
    var kind by remember { mutableStateOf("explore") }
    var origin by remember { mutableStateOf("LHR") }
    var region by remember { mutableStateOf("europe") }
    var destination by remember { mutableStateOf("") }
    var month by remember { mutableStateOf(0) }
    var duration by remember { mutableStateOf("Weekend") }
    var outbound by remember { mutableStateOf("") }
    var returnDate by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var maxPrice by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Toggle("Anywhere", kind == "explore") { kind = "explore" }
            Toggle("Route", kind == "route") { kind = "route" }
        }
        Field("Origin") {
            OutlinedTextField(origin, { origin = it.uppercase() }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("LHR") })
        }
        if (kind == "explore") {
            Field("Region") {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((v, l) in REGIONS) Toggle(l, region == v) { region = v }
                }
            }
            Field("Destination (optional)") {
                OutlinedTextField(destination, { destination = it.uppercase() }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("BCN") })
            }
            Field("Month") {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((v, l) in MONTHS) Toggle(l, month == v) { month = v }
                }
            }
            Field("Duration") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (d in DURATIONS) Toggle(d, duration == d) { duration = d }
                }
            }
        } else {
            Field("Destination") {
                OutlinedTextField(destination, { destination = it.uppercase() }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("JFK") })
            }
            Field("Outbound date (YYYY-MM-DD)") {
                OutlinedTextField(outbound, { outbound = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("2026-08-01") })
            }
            Field("Return date (optional)") {
                OutlinedTextField(returnDate, { returnDate = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("2026-08-08") })
            }
        }
        Field("Label (optional)") {
            OutlinedTextField(label, { label = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }
        Field("Alert under (£)") {
            OutlinedTextField(maxPrice, { maxPrice = it.filter { c -> c.isDigit() || c == '.' } }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("200") })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    onCreate(buildJsonObject {
                        put("kind", kind)
                        put("origin", origin.trim())
                        maxPrice.toDoubleOrNull()?.let { put("maxPriceMajor", it) }
                        if (label.isNotBlank()) put("label", label.trim())
                        if (kind == "explore") {
                            put("region", region)
                            if (destination.isNotBlank()) put("destination", destination.trim())
                            put("month", month)
                            put("duration", duration)
                        } else {
                            put("destination", destination.trim())
                            put("outboundDate", outbound.trim())
                            if (returnDate.isNotBlank()) put("returnDate", returnDate.trim())
                        }
                    })
                },
                enabled = origin.isNotBlank() && (kind == "explore" || (destination.isNotBlank() && outbound.isNotBlank())),
                modifier = Modifier.weight(1f),
            ) { Text("Add") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
private fun Field(label: String, content: @Composable () -> Unit) {
    Column {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}

@Composable
private fun Toggle(label: String, active: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { Text(label, style = MaterialTheme.typography.labelMedium) }
}
