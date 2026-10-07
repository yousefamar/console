package io.amar.console.data.agents

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What the Spaces header chip shows for the fleet's auth backend. Port of the
 *  SPA's `BackendChip` (src/components/SpacesFleetMenu.tsx). */
data class BackendChip(val label: String, val spilled: Boolean, val explanation: String)

private val RETURN_AT = DateTimeFormatter.ofPattern("EEE d MMM HH:mm", Locale.ENGLISH)

/** `null` when the hub has not said which backend it is on (older hub, or no
 *  `model_state` yet). Spilled = running on Bedrock while the human's standing
 *  choice is the subscription; a CHOSEN Bedrock reads plain. */
fun backendChipLabel(state: AgentsRepository.ModelState, zone: ZoneId = ZoneId.systemDefault()): BackendChip? {
    val backend = state.backend ?: return null
    val spilled = backend == "bedrock" && state.preferred == "first_party"
    val label = if (backend == "first_party") "Max" else "Bedrock"
    val spill = state.spill
    val explanation = when {
        spilled -> buildString {
            append("Spilled to pay-per-token Bedrock")
            spill?.window?.let { append(" — $it exhausted") }
            spill?.trippedBy?.let { append(" (tripped by $it)") }
            if (spill != null && spill.returnAt > 0) {
                append("; due back on the subscription ")
                append(Instant.ofEpochMilli(spill.returnAt).atZone(zone).format(RETURN_AT))
            }
        }
        backend == "first_party" -> "Claude Max subscription"
        else -> "Amazon Bedrock — chosen, pay-per-token"
    }
    return BackendChip(label, spilled, explanation)
}
