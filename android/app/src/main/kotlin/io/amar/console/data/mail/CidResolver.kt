package io.amar.console.data.mail

import android.util.Base64
import io.amar.console.core.HubClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * Inline CID image resolution (port of the SPA's EmailFrame cid replacement):
 * `<img src="cid:xyz">` refs in bodyHtml are swapped for data: URIs built
 * from the message's attachments (matched by contentId). Fetched via the hub
 * attachment route and disk-cached alongside the tap-to-open attachments, so
 * a re-render offline still inlines them; unresolvable cids get a
 * transparent pixel so broken-image icons don't litter the mail.
 */
object CidResolver {
    private val json = Json { ignoreUnknownKeys = true }
    private const val TRANSPARENT_PX =
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

    data class CidAttachment(val contentId: String, val messageId: String, val attachmentId: String, val mimeType: String)

    fun parseCidAttachments(attachmentsJson: String?): List<CidAttachment> {
        attachmentsJson ?: return emptyList()
        return runCatching {
            (json.parseToJsonElement(attachmentsJson) as? JsonArray)
                ?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    fun str(k: String) = (o[k] as? JsonPrimitive)?.content
                    val cid = str("contentId") ?: return@mapNotNull null
                    CidAttachment(cid, str("messageId") ?: "", str("attachmentId") ?: "", str("mimeType") ?: "image/png")
                } ?: emptyList()
        }.getOrElse { emptyList() }
    }

    /** All cid: references present in the html. */
    fun findCidRefs(html: String): Set<String> =
        Regex("""cid:([^"'\s)]+)""").findAll(html).map { it.groupValues[1] }.toSet()

    /**
     * Replace cid: refs with data URIs. [fetchBase64] resolves an attachment
     * to its base64 body (network/cache) — null on failure.
     */
    suspend fun inline(
        html: String,
        attachments: List<CidAttachment>,
        fetchBase64: suspend (CidAttachment) -> String?,
    ): String {
        var out = html
        val byId = attachments.associateBy { it.contentId }
        for (cid in findCidRefs(html)) {
            val att = byId[cid]
            val replacement = if (att != null) {
                val b64 = fetchBase64(att)
                if (b64 != null) "data:${att.mimeType};base64,$b64" else TRANSPARENT_PX
            } else TRANSPARENT_PX
            out = out.replace("cid:$cid", replacement)
        }
        return out
    }

    /** Default fetcher: hub attachment route (Gmail URL-safe base64 → std). */
    suspend fun hubFetcher(hub: HubClient): suspend (CidAttachment) -> String? = { att ->
        runCatching {
            val resp = hub.get(
                "/mail/messages/${java.net.URLEncoder.encode(att.messageId, "UTF-8")}/attachments/${java.net.URLEncoder.encode(att.attachmentId, "UTF-8")}"
            )
            val data = json.parseToJsonElement(resp).jsonObject["data"]
                ?.let { (it as? JsonPrimitive)?.content }
            data?.let {
                // Gmail returns URL-safe base64; data: URIs need standard.
                Base64.encodeToString(Base64.decode(it, Base64.URL_SAFE), Base64.NO_WRAP)
            }
        }.getOrNull()
    }
}
