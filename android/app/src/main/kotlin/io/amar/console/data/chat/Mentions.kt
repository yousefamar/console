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
}
