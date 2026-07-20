package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private val json = Json { ignoreUnknownKeys = true }

/** Hub-side glasses config — GET/POST /glasses/config (server/src/glasses/config.ts). */
data class GlassesHubConfig(
    val notifyEnabled: Boolean,
    val channels: Map<String, Boolean>,
    val hudEnabled: Boolean,
    val headUpAngleDeg: Int,
)

/** Fixed channel order matching server GLASSES_CHANNELS. */
val GLASSES_CHANNELS = listOf("mail", "chat", "calendar", "agent", "money", "generic")

fun parseGlassesConfig(raw: String): GlassesHubConfig? {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    val channels = (obj["channels"] as? JsonObject)?.mapNotNull { (k, v) ->
        (v as? JsonPrimitive)?.booleanOrNull?.let { k to it }
    }?.toMap() ?: emptyMap()
    return GlassesHubConfig(
        notifyEnabled = obj["notifyEnabled"]?.jsonPrimitive?.booleanOrNull ?: true,
        channels = channels,
        hudEnabled = obj["hudEnabled"]?.jsonPrimitive?.booleanOrNull ?: true,
        headUpAngleDeg = obj["headUpAngleDeg"]?.jsonPrimitive?.intOrNull ?: 30,
    )
}

data class MicStatus(val ownerName: String?, val hot: Boolean)

fun parseMicStatus(raw: String): MicStatus? {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    return MicStatus(
        ownerName = obj["ownerName"]?.jsonPrimitive?.content
            ?: obj["owner"]?.jsonPrimitive?.content,
        hot = obj["hot"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
}

/** Thin online-only client for the hardware-adjacent hub routes. */
class HardwareRepository(private val hub: HubClient) {

    suspend fun getGlassesConfig(): GlassesHubConfig? =
        runCatching { parseGlassesConfig(hub.get("/glasses/config")) }.getOrNull()

    suspend fun patchGlassesConfig(patch: JsonObject): GlassesHubConfig? =
        runCatching { parseGlassesConfig(hub.post("/glasses/config", patch.toString())) }.getOrNull()

    suspend fun setNotifyEnabled(v: Boolean) = patchGlassesConfig(buildJsonObject { put("notifyEnabled", v) })
    suspend fun setHudEnabled(v: Boolean) = patchGlassesConfig(buildJsonObject { put("hudEnabled", v) })
    suspend fun setHeadUpAngle(deg: Int) = patchGlassesConfig(buildJsonObject { put("headUpAngleDeg", deg) })
    suspend fun setChannel(channel: String, v: Boolean) = patchGlassesConfig(
        buildJsonObject { put("channels", buildJsonObject { put(channel, v) }) }
    )

    /** GET /pen/stream → {streaming, active}. */
    suspend fun getPenStream(): Boolean? = runCatching {
        (json.parseToJsonElement(hub.get("/pen/stream")) as? JsonObject)
            ?.get("streaming")?.jsonPrimitive?.booleanOrNull
    }.getOrNull()

    suspend fun setPenStream(enabled: Boolean): Boolean? = runCatching {
        val resp = hub.post("/pen/stream", buildJsonObject { put("enabled", enabled) }.toString())
        (json.parseToJsonElement(resp) as? JsonObject)?.get("streaming")?.jsonPrimitive?.booleanOrNull
    }.getOrNull()

    suspend fun micStatus(): MicStatus? =
        runCatching { parseMicStatus(hub.get("/mic/status")) }.getOrNull()

    /**
     * Fire a real push through POST /push/send — exercises the full
     * lens-notification pipeline (hub → notify-forwarder → 0x4B firmware card)
     * exactly as an incoming mail/chat does. Returns true on HTTP success.
     * Mirrors GlassesSettings.tsx's "Test notification".
     */
    suspend fun sendTestNotification(): Boolean = runCatching {
        hub.post(
            "/push/send",
            buildJsonObject {
                put("type", "chat")
                put("title", "Test notification")
                put("body", "If you can read this on the lenses, notifications work.")
                put("senderName", "Console")
                put("roomName", "Test")
            }.toString(),
        )
        true
    }.getOrDefault(false)
}
