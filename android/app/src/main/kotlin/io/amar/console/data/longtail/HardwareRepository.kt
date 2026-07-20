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

/** Matrix connection status — GET /matrix/hub/status (server/src/routes/matrix.ts). */
data class MatrixStatus(
    val connected: Boolean,
    val userId: String?,
    val deviceId: String?,
    val homeserver: String?,
)

fun parseMatrixStatus(raw: String): MatrixStatus? {
    val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    return MatrixStatus(
        connected = obj["hasCredentials"]?.jsonPrimitive?.booleanOrNull ?: false,
        userId = obj["userId"]?.jsonPrimitive?.content,
        deviceId = obj["deviceId"]?.jsonPrimitive?.content,
        homeserver = obj["homeserver"]?.jsonPrimitive?.content,
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

    // ---- Account management (Settings screen) ---------------------------- //

    /** Signed-in Google email (GET /auth/session → email), or "" when unknown. */
    suspend fun googleEmail(): String = runCatching {
        (json.parseToJsonElement(hub.get("/auth/session")) as? JsonObject)
            ?.get("email")?.jsonPrimitive?.content ?: ""
    }.getOrDefault("")

    /** Sign out of all Google accounts hub-side (POST /auth/logout/google). */
    suspend fun signOutGoogle(): Boolean =
        runCatching { hub.post("/auth/logout/google", "{}"); true }.getOrDefault(false)

    suspend fun matrixStatus(): MatrixStatus? =
        runCatching { parseMatrixStatus(hub.get("/matrix/hub/status")) }.getOrNull()

    /** Log the hub into Matrix (POST /matrix/hub/login). Returns null on success,
     *  else an error message for inline display. */
    suspend fun matrixLogin(homeserver: String, userId: String, password: String): String? =
        try {
            hub.post(
                "/matrix/hub/login",
                buildJsonObject {
                    put("homeserver", homeserver)
                    put("userId", userId)
                    put("password", password)
                }.toString(),
            )
            null
        } catch (e: HubClient.HttpException) {
            runCatching {
                (json.parseToJsonElement(e.body) as? JsonObject)?.get("error")?.jsonPrimitive?.content
            }.getOrNull() ?: "login failed (HTTP ${e.code})"
        } catch (e: Exception) {
            e.message ?: "network error"
        }

    suspend fun matrixLogout(): Boolean =
        runCatching { hub.post("/matrix/hub/logout", "{}"); true }.getOrDefault(false)
}
