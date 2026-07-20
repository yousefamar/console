package io.amar.console.data.longtail

import io.amar.console.data.db.BookmarkRow

/**
 * Pure bookmark helpers — no Android deps so plain-JUnit testable. Ports of the
 * SPA's src/store/bookmarks.ts filterBookmarks + BookmarkTagTree hierarchy.
 */

/** www.-stripped hostname; falls back to raw url on parse failure. */
fun bookmarkDomain(url: String?): String {
    if (url.isNullOrBlank()) return ""
    return runCatching { java.net.URI(url).host?.removePrefix("www.") }.getOrNull()
        ?: url.removePrefix("https://").removePrefix("http://").removePrefix("www.").substringBefore('/')
}

/**
 * filterBookmarks parity: tag filter (exact OR descendant `foo/…`) then a
 * case-insensitive search across title / url / description / tags.
 */
fun filterBookmarks(
    bookmarks: List<BookmarkRow>,
    tagsByFile: Map<String, List<String>>,
    searchQuery: String,
    selectedTag: String?,
): List<BookmarkRow> {
    var out = bookmarks
    if (selectedTag != null) {
        out = out.filter { bm ->
            (tagsByFile[bm.file] ?: emptyList()).any { it == selectedTag || it.startsWith("$selectedTag/") }
        }
    }
    val q = searchQuery.trim()
    if (q.isNotEmpty()) {
        val lower = q.lowercase()
        out = out.filter { bm ->
            bm.title.contains(lower, ignoreCase = true) ||
                (bm.url?.contains(lower, ignoreCase = true) == true) ||
                (bm.description?.contains(lower, ignoreCase = true) == true) ||
                (tagsByFile[bm.file] ?: emptyList()).any { it.contains(lower, ignoreCase = true) }
        }
    }
    return out
}

/** Tag-tree node (mirrors the SPA's TagTreeNode). */
data class BookmarkTagNode(
    val name: String,
    val fullPath: String,
    val count: Int,
    val children: List<BookmarkTagNode>,
)

/**
 * Build a hierarchical tag tree from the flat `foo/bar/baz` tags across all
 * bookmarks; `count` at a node = number of bookmarks whose tag is that node or
 * any descendant of it (matches how selecting a tag filters). Sorted by count desc.
 */
fun buildTagTree(tagsByFile: Map<String, List<String>>): List<BookmarkTagNode> {
    // For each full path, how many bookmarks have it (or a descendant).
    val selfCounts = mutableMapOf<String, Int>()
    for (tags in tagsByFile.values) {
        // Every ancestor of every tag counts this bookmark once.
        val ancestors = mutableSetOf<String>()
        for (tag in tags) {
            val parts = tag.split('/')
            for (i in parts.indices) ancestors.add(parts.subList(0, i + 1).joinToString("/"))
        }
        for (a in ancestors) selfCounts[a] = (selfCounts[a] ?: 0) + 1
    }
    val allPaths = selfCounts.keys

    fun build(prefix: String, depth: Int): List<BookmarkTagNode> {
        // Children at this depth whose parent path == prefix.
        val names = allPaths.mapNotNull { path ->
            val parts = path.split('/')
            if (parts.size == depth + 1 && (depth == 0 || parts.subList(0, depth).joinToString("/") == prefix)) {
                parts.last() to path
            } else null
        }.distinct()
        return names.map { (name, full) ->
            BookmarkTagNode(name, full, selfCounts[full] ?: 0, build(full, depth + 1))
        }.sortedByDescending { it.count }
    }
    return build("", 0)
}

/** All tags across bookmarks, alpha, optionally excluding some (already-selected). */
fun allBookmarkTags(tagsByFile: Map<String, List<String>>, exclude: Set<String> = emptySet()): List<String> =
    tagsByFile.values.flatten().distinct().filter { it !in exclude }.sorted()

/** Tag autocomplete: substring match, exclude already-selected, cap. */
fun tagSuggestions(all: List<String>, query: String, selected: Set<String>, max: Int): List<String> {
    if (query.isBlank()) return emptyList()
    val q = query.lowercase()
    return all.filter { it.contains(q, ignoreCase = true) && it !in selected }.take(max)
}

/** Auto-prepend https:// when the URL has no protocol (BookmarkAddBar). */
fun normalizeUrl(raw: String): String {
    val t = raw.trim()
    return if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t)) t else "https://$t"
}

/** en-GB 'd MMM yyyy' from an ISO/date string; falls back to raw on parse failure. */
fun formatAddedDate(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val ms = runCatching { java.time.Instant.parse(raw).toEpochMilli() }.getOrNull()
        ?: runCatching {
            java.time.LocalDate.parse(raw.take(10))
                .atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
        }.getOrNull()
        ?: return raw
    return java.text.SimpleDateFormat("d MMM yyyy", java.util.Locale.UK).format(java.util.Date(ms))
}
