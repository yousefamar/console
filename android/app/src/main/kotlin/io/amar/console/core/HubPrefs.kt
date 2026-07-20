package io.amar.console.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
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

    /** Read an arbitrary boolean pref (defaulted). */
    fun bool(key: String, default: Boolean = false): Boolean =
        (_prefs.value[key] as? JsonPrimitive)?.booleanOrNull ?: default

    /** Read an arbitrary string pref (or null). */
    fun string(key: String): String? =
        (_prefs.value[key] as? JsonPrimitive)?.contentOrNull

    /** Read a string-array pref (or null when absent/malformed). */
    fun stringList(key: String): List<String>? =
        (_prefs.value[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }

    suspend fun refresh(hub: HubClient) {
        runCatching {
            _prefs.value = json.parseToJsonElement(hub.get("/config")).jsonObject
        }
    }

    /**
     * Generic hub-pref write — shallow-merge PUT /config (the SPA's prefs.ts
     * semantics). Optimistic local flip first, fire-and-forget PUT. This is the
     * single write API; DND + calendar visibility all route through it.
     */
    suspend fun setPref(hub: HubClient, key: String, value: JsonElement) {
        _prefs.value = JsonObject(_prefs.value + (key to value))
        runCatching {
            hub.put("/config", buildJsonObject { put(key, value) }.toString())
        }
    }

    /** Shallow-merge several keys at once (calendar visibility + overlay-seen
     *  are written atomically). Optimistic local merge + one PUT. */
    suspend fun setPrefs(hub: HubClient, patch: JsonObject) {
        _prefs.value = JsonObject(_prefs.value + patch)
        runCatching { hub.put("/config", patch.toString()) }
    }

    suspend fun setDnd(hub: HubClient, enabled: Boolean) =
        setPref(hub, "dnd", JsonPrimitive(enabled))
}
