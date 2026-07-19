package io.amar.console.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Hub-synced user prefs — the mobile mirror of src/prefs.ts (`/config`,
 * shallow-merge PUT). Cross-device state like DND lives HERE, not in
 * SharedPreferences: toggling DND on the phone silences desktop too.
 * Fetched on each reconcile; writes are optimistic + fire-and-forget.
 */
object HubPrefs {
    private val json = Json { ignoreUnknownKeys = true }

    private val _prefs = MutableStateFlow<JsonObject>(JsonObject(emptyMap()))
    val prefs: StateFlow<JsonObject> = _prefs

    val dnd: Boolean get() = (_prefs.value["dnd"] as? JsonPrimitive)?.booleanOrNull ?: false

    suspend fun refresh(hub: HubClient) {
        runCatching {
            _prefs.value = json.parseToJsonElement(hub.get("/config")).jsonObject
        }
    }

    suspend fun setDnd(hub: HubClient, enabled: Boolean) {
        // Optimistic local flip.
        _prefs.value = JsonObject(_prefs.value + ("dnd" to JsonPrimitive(enabled)))
        runCatching {
            hub.put("/config", buildJsonObject { put("dnd", JsonPrimitive(enabled)) }.toString())
        }
    }
}
