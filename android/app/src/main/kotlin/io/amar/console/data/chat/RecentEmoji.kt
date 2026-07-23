package io.amar.console.data.chat

import android.content.Context

/**
 * Frequency-ranked personal reaction emoji — the quick-react row shows the
 * emoji YOU actually use, not a generic six. Counts persist in
 * SharedPreferences as "emoji:count" lines; every reaction bumps its emoji.
 * Ties break toward most-recently-used (a lastUsed timestamp per emoji).
 */
object RecentEmoji {
    private const val PREFS = "recent_emoji"
    private const val KEY_COUNTS = "counts"

    /** Seed shown until the user has actual history. */
    private val DEFAULT = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

    private data class Entry(val emoji: String, val count: Int, val lastUsed: Long)

    private fun load(ctx: Context): MutableList<Entry> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_COUNTS, "") ?: ""
        return raw.lineSequence().mapNotNull { line ->
            val parts = line.split('\t')
            if (parts.size == 3) {
                val c = parts[1].toIntOrNull(); val t = parts[2].toLongOrNull()
                if (c != null && t != null && parts[0].isNotBlank()) Entry(parts[0], c, t) else null
            } else null
        }.toMutableList()
    }

    private fun save(ctx: Context, entries: List<Entry>) {
        // Cap the ledger so it can't grow unbounded (top 64 by count).
        val kept = entries.sortedByDescending { it.count }.take(64)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_COUNTS, kept.joinToString("\n") { "${it.emoji}\t${it.count}\t${it.lastUsed}" })
            .apply()
    }

    /** Record a use (call whenever a reaction is sent). */
    fun bump(ctx: Context, emoji: String) {
        val entries = load(ctx)
        val i = entries.indexOfFirst { it.emoji == emoji }
        val now = System.currentTimeMillis()
        if (i >= 0) entries[i] = entries[i].copy(count = entries[i].count + 1, lastUsed = now)
        else entries.add(Entry(emoji, 1, now))
        save(ctx, entries)
    }

    /** Top [n] personal emoji, backfilled with defaults the user hasn't used. */
    fun top(ctx: Context, n: Int = 6): List<String> {
        val mine = load(ctx)
            .sortedWith(compareByDescending<Entry> { it.count }.thenByDescending { it.lastUsed })
            .map { it.emoji }
        return (mine + DEFAULT.filter { it !in mine }).take(n)
    }
}
