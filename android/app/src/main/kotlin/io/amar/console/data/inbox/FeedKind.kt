package io.amar.console.data.inbox

import io.amar.console.data.db.FeedRow

/**
 * Platform classification for feed subscriptions — port of
 * src/feeds/feed-kind.ts (keep in sync). Drives the Feed list's platform
 * chips and the per-row glyph; anything unrecognised is plain [RSS].
 */
enum class FeedKind(val label: String) {
    YOUTUBE("YouTube"), REDDIT("Reddit"), HN("Hacker News"), SUBSTACK("Substack"), X("X"), RSS("RSS");

    companion object {
        /** Chip/glyph order — most-populated platforms first, generic RSS last. */
        val ORDER: List<FeedKind> = listOf(YOUTUBE, REDDIT, HN, SUBSTACK, X, RSS)
    }
}

private fun host(url: String?): String {
    if (url.isNullOrBlank()) return ""
    return runCatching { java.net.URI(url).host?.lowercase()?.removePrefix("www.") ?: "" }.getOrDefault("")
}

/** Proxied feeds (granary, rsshub, kill-the-newsletter) carry the real platform in `url=`. */
private fun candidateHosts(xmlUrl: String?, siteUrl: String?): List<String> {
    val out = mutableListOf(host(xmlUrl), host(siteUrl))
    if (!xmlUrl.isNullOrBlank()) {
        runCatching {
            val q = java.net.URI(xmlUrl).rawQuery ?: ""
            q.split('&').firstOrNull { it.startsWith("url=") }?.substringAfter("url=")?.let {
                out += host(java.net.URLDecoder.decode(it, "UTF-8"))
            }
        }
    }
    return out.filter { it.isNotEmpty() }
}

fun feedKind(xmlUrl: String?, siteUrl: String?): FeedKind {
    for (h in candidateHosts(xmlUrl, siteUrl)) {
        if (h == "youtube.com" || h.endsWith(".youtube.com") || h == "youtu.be") return FeedKind.YOUTUBE
        if (h == "reddit.com" || h.endsWith(".reddit.com")) return FeedKind.REDDIT
        if (h == "hnrss.org" || h == "news.ycombinator.com") return FeedKind.HN
        if (h.endsWith(".substack.com")) return FeedKind.SUBSTACK
        if (h == "x.com" || h == "twitter.com" || h.endsWith(".twitter.com") || h.startsWith("nitter.")) return FeedKind.X
    }
    if (Regex("/twitter/").containsMatchIn((xmlUrl ?: "").lowercase())) return FeedKind.X
    return FeedKind.RSS
}

fun feedKind(feed: FeedRow?): FeedKind = if (feed == null) FeedKind.RSS else feedKind(feed.xmlUrl, feed.siteUrl)

/** Chips for the Feed list: one per kind present, in [FeedKind.ORDER], with counts. */
fun feedKindsPresent(entries: List<InboxEntry>): List<Pair<FeedKind, Int>> {
    val counts = HashMap<FeedKind, Int>()
    for (e in entries) e.feedKind?.let { counts[it] = (counts[it] ?: 0) + 1 }
    return FeedKind.ORDER.mapNotNull { k -> counts[k]?.let { k to it } }
}

fun filterByFeedKind(entries: List<InboxEntry>, kind: FeedKind?): List<InboxEntry> =
    if (kind == null) entries else entries.filter { it.feedKind == kind }
