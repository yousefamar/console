package io.amar.console.data.cal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI

/**
 * Private per-event links — port of src/calendar/links.ts (itself a client port
 * of server/src/calendar-links.ts). Keep the key grammar in sync with both.
 *
 * Google has no private-notes field; the one channel other guests never see is
 * `extendedProperties.private` on YOUR copy of the event. Links are stored as
 * `console.link.<i>` (+ the constant marker `console.links=1` the hub filters on).
 * A link is just a string — vault-relative note, absolute path, or URL.
 */

const val LINK_KEY_PREFIX = "console.link."
const val LINK_MARKER_KEY = "console.links"
const val LINK_MARKER_VALUE = "1"

private val lenient = Json { ignoreUnknownKeys = true }

private fun privateProps(event: JsonObject?): JsonObject? =
    (event?.get("extendedProperties") as? JsonObject)?.get("private") as? JsonObject

/** Ordered links from an event's `extendedProperties.private` (by numeric index). */
fun readLinks(event: JsonObject?): List<String> {
    val priv = privateProps(event) ?: return emptyList()
    return priv.entries
        .filter { (k, v) -> k.startsWith(LINK_KEY_PREFIX) && v is JsonPrimitive && v.isString && v.content.isNotEmpty() }
        .mapNotNull { (k, v) ->
            val idx = k.substring(LINK_KEY_PREFIX.length).toIntOrNull() ?: return@mapNotNull null
            if (idx < 0) null else idx to v.jsonPrimitive.content
        }
        .sortedBy { it.first }
        .map { it.second }
}

fun readLinks(rawJson: String): List<String> =
    readLinks(runCatching { lenient.parseToJsonElement(rawJson).jsonObject }.getOrNull())

/**
 * The event JSON with its private link set REPLACED by [links] — the local twin of
 * the hub's `linksPatch`: every old `console.link.<i>` key is dropped, the new set
 * laid out `0..n-1`, and the marker added (or removed when the set is empty). Used
 * for the optimistic Room write; the hub does the real PATCH.
 */
fun withLinks(event: JsonObject, links: List<String>): JsonObject {
    val ext = (event["extendedProperties"] as? JsonObject) ?: JsonObject(emptyMap())
    val priv = (ext["private"] as? JsonObject) ?: JsonObject(emptyMap())
    val nextPriv = buildJsonObject {
        priv.forEach { (k, v) ->
            if (!k.startsWith(LINK_KEY_PREFIX) && k != LINK_MARKER_KEY) put(k, v)
        }
        links.forEachIndexed { i, l -> put("$LINK_KEY_PREFIX$i", l) }
        if (links.isNotEmpty()) put(LINK_MARKER_KEY, LINK_MARKER_VALUE)
    }
    val nextExt = buildJsonObject {
        ext.forEach { (k, v) -> if (k != "private") put(k, v) }
        put("private", nextPriv)
    }
    return buildJsonObject {
        event.forEach { (k, v) -> if (k != "extendedProperties") put(k, v) }
        put("extendedProperties", nextExt)
    }
}

fun withLinks(rawJson: String, links: List<String>): String {
    val e = runCatching { lenient.parseToJsonElement(rawJson).jsonObject }.getOrNull() ?: JsonObject(emptyMap())
    return withLinks(e, links).toString()
}

/** Append a link (no duplicates, trimmed). */
fun addLink(current: List<String>, link: String): List<String> {
    val l = link.trim()
    if (l.isEmpty() || l in current) return current
    return current + l
}

fun removeLink(current: List<String>, link: String): List<String> = current.filter { it != link.trim() }

// -------------------------------------------------------------------------- //
// Classification (what tapping a link does)

sealed class LinkKind(val label: String) {
    class Url(label: String, val href: String) : LinkKind(label)
    /** A file inside the vault — opens in the Notes editor. */
    class Vault(label: String, val vaultPath: String) : LinkKind(label)
    /** A local file the hub media bridge (`/agents/local-file`) can serve. */
    class Media(label: String, val path: String, val image: Boolean) : LinkKind(label)
    /** Anything else — shown as a path with copy; nothing to open on the phone. */
    class File(label: String, val path: String) : LinkKind(label)
}

private val MEDIA_EXT = Regex("\\.(png|jpe?g|gif|webp|avif|bmp|svg|pdf|mp4|webm|mov)$", RegexOption.IGNORE_CASE)
private val IMAGE_EXT = Regex("\\.(png|jpe?g|gif|webp|avif|bmp|svg)$", RegexOption.IGNORE_CASE)
private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)

/** Classify a stored link. [vaultRoot] is the absolute vault dir (hub
 *  `/notes/vault-path`); without it, absolute vault files fall through to [LinkKind.File]. */
fun classifyLink(link: String, vaultRoot: String?): LinkKind {
    val l = link.trim()
    if (SCHEME.containsMatchIn(l)) {
        val label = runCatching {
            val u = URI(l)
            val host = (u.host ?: "").removePrefix("www.")
            val path = u.rawPath ?: ""
            if (host.isEmpty()) l else host + (if (path.isNotEmpty() && path != "/") path else "")
        }.getOrDefault(l)
        return LinkKind.Url(label, l)
    }
    val base = l.split('/').filter { it.isNotEmpty() }.lastOrNull() ?: l
    if (!vaultRoot.isNullOrBlank()) {
        val root = vaultRoot.trimEnd('/') + "/"
        if (l.startsWith(root)) return LinkKind.Vault(base, l.substring(root.length))
    }
    // Vault-relative shorthand (`projects/x/note.md`) — not absolute, ends in .md.
    if (!l.startsWith("/") && !l.startsWith("~") && l.endsWith(".md", ignoreCase = true)) return LinkKind.Vault(base, l)
    if (MEDIA_EXT.containsMatchIn(l)) return LinkKind.Media(base, l, IMAGE_EXT.containsMatchIn(l))
    return LinkKind.File(base, l)
}

/** Hub media-bridge URL for a local file (bearer is attached by the app's Coil loader). */
fun mediaBridgeUrl(hubBase: String, path: String): String =
    hubBase + "/agents/local-file?path=" + java.net.URLEncoder.encode(path, "UTF-8")
