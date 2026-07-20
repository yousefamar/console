package io.amar.console.data.feeds

import io.amar.console.data.db.FeedItemRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Pure feeds helpers — no Android deps so plain-JUnit testable.
 */

private val feedsJson = Json { ignoreUnknownKeys = true }

private val YOUTUBE_RE = Regex("(?:youtube\\.com/(?:watch\\?v=|shorts/)|youtu\\.be/)([a-zA-Z0-9_-]+)")

/** Port of the SPA's src/utils/youtube.ts extractYoutubeId. */
fun extractYoutubeId(url: String?): String? =
    url?.let { YOUTUBE_RE.find(it)?.groupValues?.get(1) }

fun youtubeThumbUrl(id: String): String = "https://img.youtube.com/vi/$id/hqdefault.jpg"

fun youtubeWatchUrl(id: String): String = "https://www.youtube.com/watch?v=$id"

/**
 * Per-folder unread counts. Key `null` = the "All" bucket (total unread);
 * feeds without a folder only count toward All (mirrors the SPA's top-level
 * unfoldered feeds).
 */
fun folderUnreadCounts(
    items: List<FeedItemRow>,
    feedFolders: Map<String, String?>,
    readIds: Set<String>,
): Map<String?, Int> {
    val counts = mutableMapOf<String?, Int>()
    for (item in items) {
        if (item.id in readIds) continue
        counts[null] = (counts[null] ?: 0) + 1
        val folder = feedFolders[item.feedId] ?: continue
        counts[folder] = (counts[folder] ?: 0) + 1
    }
    return counts
}

/** Distinct folder names, stable order (first-seen), for the chip row. */
fun folderNames(feedFolders: Map<String, String?>): List<String> =
    feedFolders.values.filterNotNull().distinct()

/** Per-feed unread counts. */
fun feedUnreadCounts(items: List<FeedItemRow>, readIds: Set<String>): Map<String, Int> {
    val counts = mutableMapOf<String, Int>()
    for (item in items) {
        if (item.id in readIds) continue
        counts[item.feedId] = (counts[item.feedId] ?: 0) + 1
    }
    return counts
}

/**
 * Relative time à la FeedItemListEntry.tsx: 'now' <1m, Nm <60m, Nh <24h,
 * Nd <7d, 'Mon D' <1yr, 'Mon D, YYYY' older. [now] injectable for tests.
 */
fun relativeTime(publishedMs: Long, now: Long): String {
    if (publishedMs <= 0) return ""
    val diff = now - publishedMs
    if (diff < 0) return relativeTime(publishedMs, publishedMs) // future → 'now'
    val min = diff / 60_000
    if (min < 1) return "now"
    if (min < 60) return "${min}m"
    val hours = min / 60
    if (hours < 24) return "${hours}h"
    val days = hours / 24
    if (days < 7) return "${days}d"
    val cal = java.util.Calendar.getInstance().apply { timeInMillis = publishedMs }
    val nowCal = java.util.Calendar.getInstance().apply { timeInMillis = now }
    val fmt = if (cal.get(java.util.Calendar.YEAR) == nowCal.get(java.util.Calendar.YEAR)) "MMM d" else "MMM d, yyyy"
    return java.text.SimpleDateFormat(fmt, java.util.Locale.US).format(java.util.Date(publishedMs))
}

// --- HN comments (port of FeedItemView's HN tree) --- //

/** Extract the HN item id embedded in an article's content HTML, if present. */
fun extractHnItemId(content: String?): String? {
    if (content == null) return null
    return Regex("news\\.ycombinator\\.com/item\\?id=(\\d+)").find(content)?.groupValues?.get(1)
}

data class HnComment(
    val id: Long,
    val by: String?,
    val text: String?,
    val time: Long,
    val score: Int?,
    val descendants: Int?,
    val children: List<HnComment>,
)

/** Parse the raw /feeds/hn/:id tree JSON into a nested [HnComment]. */
fun parseHnTree(raw: String?): HnComment? {
    if (raw.isNullOrBlank()) return null
    return runCatching {
        val obj = feedsJson.parseToJsonElement(raw) as? JsonObject ?: return null
        hnCommentFrom(obj)
    }.getOrNull()
}

private fun hnCommentFrom(obj: JsonObject): HnComment {
    val kids = (obj["children"] as? JsonArray)
        ?.mapNotNull { (it as? JsonObject)?.let(::hnCommentFrom) } ?: emptyList()
    return HnComment(
        id = obj["id"]?.jsonPrimitive?.longOrNull ?: 0L,
        by = obj["by"]?.jsonPrimitive?.content,
        text = obj["text"]?.jsonPrimitive?.content,
        time = obj["time"]?.jsonPrimitive?.longOrNull ?: 0L,
        score = obj["score"]?.jsonPrimitive?.intOrNull,
        descendants = obj["descendants"]?.jsonPrimitive?.intOrNull,
        children = kids,
    )
}

/** HN 'time ago' — matches FeedItemView.formatTimeAgo. [now] in seconds. */
fun hnTimeAgo(unixTimeSec: Long, nowSec: Long): String {
    val seconds = nowSec - unixTimeSec
    if (seconds < 60) return "just now"
    val minutes = seconds / 60
    if (minutes < 60) return "${minutes}m ago"
    val hours = minutes / 60
    if (hours < 24) return "${hours}h ago"
    return "${hours / 24}d ago"
}

/** www.-stripped hostname for list-item + triage display. */
fun stripDomain(url: String?): String {
    if (url.isNullOrBlank()) return ""
    return runCatching { java.net.URI(url).host?.removePrefix("www.") }.getOrNull()
        ?: url.removePrefix("https://").removePrefix("http://").removePrefix("www.").substringBefore('/')
}
