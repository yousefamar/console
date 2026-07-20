package io.amar.console.data.chat

/**
 * @-mention autocomplete text logic — pure port of the SPA's
 * ChatComposeInput @-detection. The `@` only arms the picker at start of
 * input or after whitespace, so emails (alice@example.com) never trigger.
 * Plain-text `@DisplayName` insertion is enough — the hub/bridges resolve it.
 */
object Mentions {

    data class ActiveQuery(val query: String, val startIdx: Int)

    private val AT_QUERY = Regex("""(?:^|\s)@([^\s@]*)$""")

    /** The in-flight `@query` at the end of [text], or null. [startIdx]
     *  points at the `@` itself. */
    fun activeQuery(text: String): ActiveQuery? {
        val m = AT_QUERY.find(text) ?: return null
        val query = m.groupValues[1]
        val startIdx = m.range.first + if (m.value.startsWith("@")) 0 else 1
        return ActiveQuery(query, startIdx)
    }

    /** Replace the in-flight `@query` with `@DisplayName ` (trailing space
     *  ends the mention so typing continues normally). */
    fun insert(text: String, active: ActiveQuery, displayName: String): String {
        val before = text.substring(0, active.startIdx)
        val after = text.substring(active.startIdx + 1 + active.query.length)
        return "$before@$displayName $after"
    }

    /** Case-insensitive member filter for the suggestion row. */
    fun filterMembers(
        members: List<ChatRepository.RoomMember>,
        query: String,
        limit: Int = 5,
    ): List<ChatRepository.RoomMember> {
        val q = query.lowercase()
        return members
            .filter { q.isEmpty() || it.displayName.lowercase().contains(q) }
            .sortedByDescending { it.displayName.lowercase().startsWith(q) }
            .take(limit)
    }

    data class Mention(val displayName: String, val userId: String)

    /**
     * MSC3952 intentional-mention build (SPA buildMentionsFormatted parity):
     * from a set of candidate `@Name → userId` mentions, keep only those still
     * present in [body] as a discrete `@Name` token, replace each with a
     * matrix.to anchor in an HTML formatted_body, and return the surviving
     * userIds for `m.mentions.user_ids`. Longer names replace first so
     * "@Alice Smith" wins over a bare "@Alice". Returns null when no mention
     * survives (send a plain-text message).
     */
    data class Formatted(val formattedBody: String, val userIds: List<String>)

    fun buildMentionsFormatted(body: String, mentions: List<Mention>): Formatted? {
        // Dedup by userId keeping first (picked) occurrence.
        val seen = HashSet<String>()
        val uniq = mentions.filter { seen.add(it.userId) }
        val active = uniq.filter { m -> tokenRegex(m.displayName).containsMatchIn(body) }
        if (active.isEmpty()) return null
        val sorted = active.sortedByDescending { it.displayName.length }
        var html = escapeHtml(body)
        for (m in sorted) {
            // Re-scan the escaped HTML — display names are escaped identically.
            val re = tokenRegex(escapeHtml(m.displayName))
            val link = "<a href=\"https://matrix.to/#/${uriEncode(m.userId)}\">@${escapeHtml(m.displayName)}</a>"
            html = re.replace(html) { mr -> "${mr.groupValues[1]}$link" }
        }
        return Formatted(html, active.map { it.userId })
    }

    private fun tokenRegex(displayName: String): Regex =
        Regex("(^|\\s|[.,!?:;])@${Regex.escape(displayName)}(?=$|\\s|[.,!?:;])")

    private fun escapeHtml(s: String): String = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    private fun uriEncode(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
