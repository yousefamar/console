package io.amar.console.core

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** One released version's notes, as `scripts/changelog.py` writes them into latest.json. */
data class ChangelogVersion(val versionCode: Int, val date: String, val items: List<String>)

object Changelog {
    private val DATE = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.ENGLISH)

    /** Takes latest.json itself or a bare `changelog` array. Malformed entries and
     *  versions with no notes are dropped; the result is newest first. */
    fun parse(raw: String?): List<ChangelogVersion> {
        if (raw.isNullOrBlank()) return emptyList()
        val root = runCatching { Json.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
        val entries = when (root) {
            is JsonArray -> root
            is JsonObject -> root["changelog"] as? JsonArray
            else -> null
        } ?: return emptyList()
        return entries.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val code = (o["versionCode"] as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
            val items = (o["items"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim() }
                .filter { it.isNotEmpty() }
            if (items.isEmpty()) return@mapNotNull null
            ChangelogVersion(code, (o["date"] as? JsonPrimitive)?.contentOrNull.orEmpty(), items)
        }.distinctBy { it.versionCode }.sortedByDescending { it.versionCode }
    }

    fun encode(versions: List<ChangelogVersion>): String = buildJsonArray {
        for (v in versions) add(buildJsonObject {
            put("versionCode", v.versionCode)
            put("date", v.date)
            put("items", buildJsonArray { v.items.forEach { add(it) } })
        })
    }.toString()

    /** The versions an update from [afterExclusive] to [upToInclusive] brings. */
    fun between(all: List<ChangelogVersion>, afterExclusive: Int, upToInclusive: Int): List<ChangelogVersion> =
        all.filter { it.versionCode > afterExclusive && it.versionCode <= upToInclusive }

    /** Notes to show once after an update. [lastSeen] 0 means nothing was ever
     *  recorded (a first install, or the first build with this screen): show the
     *  installed version only, never the whole history. */
    fun unseen(all: List<ChangelogVersion>, lastSeen: Int, installed: Int): List<ChangelogVersion> =
        if (lastSeen >= installed) emptyList()
        else between(all, if (lastSeen <= 0) installed - 1 else lastSeen, installed)

    /** "2026-10-09" → "9 Oct 2026"; anything unparseable is shown as written. */
    fun dateLabel(iso: String): String = runCatching { LocalDate.parse(iso).format(DATE) }.getOrDefault(iso)
}
