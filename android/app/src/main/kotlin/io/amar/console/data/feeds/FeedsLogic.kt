package io.amar.console.data.feeds

import io.amar.console.data.db.FeedItemRow

/**
 * Pure feeds helpers — no Android deps so plain-JUnit testable.
 */

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
