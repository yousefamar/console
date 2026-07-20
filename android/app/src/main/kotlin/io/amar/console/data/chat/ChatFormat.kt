package io.amar.console.data.chat

/**
 * Pure UI-adjacent chat helpers: bridge-network glyphs, word-level edit diff,
 * media caption suppression. Kept in data/chat so they're unit-testable
 * without Compose. The SPA uses react-icons brand SVGs for the network badge;
 * Android has no bundled brand-icon set, so we map to a distinct glyph per
 * network (parity in COVERAGE — all 12 networks — not exact brand vectors).
 */
object ChatFormat {

    /** Glyph for a bridge network badge (SPA NETWORK_ICONS — 12 networks). */
    fun networkGlyph(networkIcon: String?): String? = when (networkIcon?.lowercase()) {
        "whatsapp" -> "🟢"
        "slack" -> "#"
        "discord" -> "🎮"
        "instagram" -> "📸"
        "signal" -> "🔵"
        "telegram" -> "✈️"
        "linkedin" -> "in"
        "facebook" -> "f"
        "twitter", "x" -> "𝕏"
        "googlechat" -> "💬"
        "gmessages" -> "🗨️"
        "imessage" -> "🍏"
        else -> null
    }

    /** A run of the edit word-diff. */
    enum class DiffKind { UNCHANGED, ADDED, REMOVED }
    data class DiffPart(val text: String, val kind: DiffKind)

    /**
     * Word-level diff (SPA diffWords via jsdiff): tokenise both strings on
     * word boundaries (keeping whitespace), compute an LCS, and emit runs.
     * Removed = struck red, added = green, unchanged = normal. Adjacent runs
     * of the same kind are merged so the render is compact.
     */
    fun wordDiff(original: String, edited: String): List<DiffPart> {
        val a = tokenize(original)
        val b = tokenize(edited)
        // LCS table.
        val n = a.size
        val m = b.size
        val lcs = Array(n + 1) { IntArray(m + 1) }
        for (i in n - 1 downTo 0) {
            for (j in m - 1 downTo 0) {
                lcs[i][j] = if (a[i] == b[j]) lcs[i + 1][j + 1] + 1
                else maxOf(lcs[i + 1][j], lcs[i][j + 1])
            }
        }
        val out = ArrayList<DiffPart>()
        fun push(text: String, kind: DiffKind) {
            if (text.isEmpty()) return
            val last = out.lastOrNull()
            if (last != null && last.kind == kind) out[out.size - 1] = last.copy(text = last.text + text)
            else out.add(DiffPart(text, kind))
        }
        var i = 0
        var j = 0
        while (i < n && j < m) {
            when {
                a[i] == b[j] -> { push(a[i], DiffKind.UNCHANGED); i++; j++ }
                lcs[i + 1][j] >= lcs[i][j + 1] -> { push(a[i], DiffKind.REMOVED); i++ }
                else -> { push(b[j], DiffKind.ADDED); j++ }
            }
        }
        while (i < n) { push(a[i], DiffKind.REMOVED); i++ }
        while (j < m) { push(b[j], DiffKind.ADDED); j++ }
        return out
    }

    // Split into word tokens keeping whitespace as its own tokens.
    private fun tokenize(s: String): List<String> =
        Regex("""\s+|[^\s]+""").findAll(s).map { it.value }.toList()

    /** File-extension-only caption suppression for image/video (SPA rule):
     *  a body that's just a filename with a media extension is noise. */
    private val IMAGE_EXT = Regex("""\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$""", RegexOption.IGNORE_CASE)
    private val VIDEO_EXT = Regex("""\.(mp4|mov|webm|mkv|avi|m4v|3gp)$""", RegexOption.IGNORE_CASE)

    fun isImageFilenameCaption(body: String?): Boolean {
        val b = body?.trim() ?: return false
        return b == "image" || (IMAGE_EXT.containsMatchIn(b) && !b.contains(' '))
    }

    fun isVideoFilenameCaption(body: String?): Boolean {
        val b = body?.trim() ?: return false
        return b == "video" || (VIDEO_EXT.containsMatchIn(b) && !b.contains(' '))
    }
}
