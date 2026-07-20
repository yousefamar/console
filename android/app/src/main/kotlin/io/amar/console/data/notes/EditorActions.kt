package io.amar.console.data.notes

/**
 * Pure text-transform helpers for the notes editor — ports of the SPA's
 * wrapSelection / insertFootnote / URL-linkify logic (src/components/
 * NotesEditorCore.tsx, src/notes/editor-actions.ts). They operate on a plain
 * (text, selStart, selEnd) triple and return the new text + new selection so
 * the Compose editor can apply them to a TextFieldValue. No editor dependency
 * → fully unit-testable.
 */
object EditorActions {
    /** New buffer + selection after an edit; [selStart]==[selEnd] means a caret. */
    data class Edit(val text: String, val selStart: Int, val selEnd: Int)

    /**
     * Toggle a symmetric marker (**, *, ~~, `) around the selection.
     *  - selection already wrapped (inside or with markers just outside) → unwrap
     *  - non-empty selection → wrap
     *  - empty selection → insert the pair, caret between
     * Mirrors NotesEditorCore.wrapSelection.
     */
    fun wrap(text: String, selStart: Int, selEnd: Int, marker: String): Edit {
        val from = selStart.coerceIn(0, text.length)
        val to = selEnd.coerceIn(from, text.length)
        val len = marker.length
        val selected = text.substring(from, to)

        // Already wrapped inside the selection → unwrap.
        if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
            val unwrapped = selected.substring(len, selected.length - len)
            val newText = text.substring(0, from) + unwrapped + text.substring(to)
            return Edit(newText, from, from + unwrapped.length)
        }

        // Markers just OUTSIDE the selection → strip them.
        val before = text.substring(maxOf(0, from - len), from)
        val after = text.substring(to, minOf(text.length, to + len))
        if (before == marker && after == marker) {
            val newText = text.substring(0, from - len) + selected + text.substring(to + len)
            return Edit(newText, from - len, to - len)
        }

        // Wrap, or insert empty pair at the caret.
        return if (from == to) {
            val newText = text.substring(0, from) + marker + marker + text.substring(from)
            Edit(newText, from + len, from + len)
        } else {
            val newText = text.substring(0, from) + marker + selected + marker + text.substring(to)
            Edit(newText, from, from + len + selected.length + len)
        }
    }

    /**
     * Insert a markdown footnote: `[^N]` at the caret + `[^N]: ` definition at
     * doc end (blank-line separated), N one past the highest existing footnote.
     * Caret lands after the definition marker, ready to type. Mirrors
     * editor-actions.insertFootnote.
     */
    fun insertFootnote(text: String, caret: Int): Edit {
        var max = 0
        for (m in Regex("\\[\\^(\\d+)]").findAll(text)) {
            val n = m.groupValues[1].toIntOrNull() ?: continue
            if (n > max) max = n
        }
        val n = max + 1
        val ref = "[^$n]"
        val at = caret.coerceIn(0, text.length)
        val withRef = text.substring(0, at) + ref + text.substring(at)

        // Separator is computed from the ORIGINAL text (matches the SPA, which
        // appends the definition at the pre-insert doc end).
        val sep = when {
            text.isEmpty() -> ""
            text.endsWith("\n\n") -> ""
            text.endsWith("\n") -> "\n"
            else -> "\n\n"
        }
        val def = "$sep[^$n]: "
        val newText = withRef + def
        val cursor = newText.length
        return Edit(newText, cursor, cursor)
    }

    /**
     * Wrap a non-empty selection as a markdown link `[selected](url)`; caret
     * after the link. Mirrors the DOM paste-URL-over-selection path.
     */
    fun linkify(text: String, selStart: Int, selEnd: Int, url: String): Edit {
        val from = selStart.coerceIn(0, text.length)
        val to = selEnd.coerceIn(from, text.length)
        val selected = text.substring(from, to)
        val link = "[$selected]($url)"
        val newText = text.substring(0, from) + link + text.substring(to)
        val cursor = from + link.length
        return Edit(newText, cursor, cursor)
    }

    /** Insert an arbitrary snippet at the caret; caret after the snippet. */
    fun insert(text: String, caret: Int, snippet: String): Edit {
        val at = caret.coerceIn(0, text.length)
        val newText = text.substring(0, at) + snippet + text.substring(at)
        return Edit(newText, at + snippet.length, at + snippet.length)
    }

    /**
     * Insert a wiki link at the selection: with a selection → `[[target|sel]]`,
     * without → `[[target]]`; caret after the insert. `.md` stripped from
     * target. Mirrors NotesLinkPicker wiki insertion.
     */
    fun insertWikiLink(text: String, selStart: Int, selEnd: Int, target: String): Edit {
        val from = selStart.coerceIn(0, text.length)
        val to = selEnd.coerceIn(from, text.length)
        val selected = text.substring(from, to)
        val clean = target.removeSuffix(".md")
        val link = if (selected.isNotEmpty()) "[[$clean|$selected]]" else "[[$clean]]"
        val newText = text.substring(0, from) + link + text.substring(to)
        val cursor = from + link.length
        return Edit(newText, cursor, cursor)
    }

    /**
     * Insert a markdown URL link `[display](url)`, display falling back to the
     * URL. Replaces the selection. Mirrors NotesLinkPicker URL insertion.
     */
    fun insertUrlLink(text: String, selStart: Int, selEnd: Int, url: String, display: String): Edit {
        val from = selStart.coerceIn(0, text.length)
        val to = selEnd.coerceIn(from, text.length)
        val label = display.ifBlank { url }
        val link = "[$label]($url)"
        val newText = text.substring(0, from) + link + text.substring(to)
        val cursor = from + link.length
        return Edit(newText, cursor, cursor)
    }

    /**
     * Insert dictation chunk at the caret with smart spacing — a space only
     * when gluing two word characters. Mirrors WriteActionBar dictation insert.
     */
    fun insertDictation(text: String, caret: Int, chunk: String): Edit {
        val at = caret.coerceIn(0, text.length)
        val prev = if (at > 0) text[at - 1] else ' '
        val firstChunkChar = chunk.firstOrNull() ?: return Edit(text, at, at)
        val glue = prev.isWordChar() && firstChunkChar.isWordChar()
        val snippet = (if (glue) " " else "") + chunk
        return insert(text, at, snippet)
    }

    private fun Char.isWordChar(): Boolean = isLetterOrDigit() || this == '_'

    private val urlRe = Regex("^https?://\\S+$")

    /** Is [s] a single bare http(s) URL with no whitespace? */
    fun isBareUrl(s: String): Boolean = urlRe.matches(s.trim()) && !s.trim().contains(Regex("\\s"))

    /**
     * Detect that a `[[` was just typed at [caret] (the char before the caret
     * and the one before that are both `[`) — opens the wiki picker. Mirrors
     * NotesEditorCore's inputHandler.
     */
    fun justTypedWikiOpen(text: String, caret: Int): Boolean =
        caret >= 2 && text[caret - 1] == '[' && text[caret - 2] == '['
}
