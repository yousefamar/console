package io.amar.console.data.notes

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Live-buffer mirror — port of the SPA's `mirrorLiveBuffer` (src/store/notes.ts,
 * ^tame-hare). The buffer ON SCREEN (dirty or clean — "what am I looking at" is
 * the context) mirrors to the hub's single `POST /notes/live` slot on a short
 * debounce, so an agent asked to help with a draft (`con notes live`) sees the
 * phone's unsaved keystrokes too. Leaving the editor clears the slot, but only
 * when this client is the one that last filled it. Fire-and-forget: a failed
 * POST just leaves the agent a staler copy.
 */
class LiveBufferMirror(
    private val scope: CoroutineScope,
    private val post: suspend (json: String) -> Unit,
    private val debounceMs: Long = DEBOUNCE_MS,
) {
    private var pending: Job? = null
    private var lastMirroredPath: String? = null

    fun update(path: String, content: String, cursorLine: Int?, selection: String?) {
        pending?.cancel()
        pending = scope.launch {
            delay(debounceMs)
            lastMirroredPath = path
            runCatching { post(LiveBufferLogic.payload(path, content, cursorLine, selection)) }
        }
    }

    fun clear() {
        pending?.cancel()
        pending = null
        if (lastMirroredPath == null) return
        lastMirroredPath = null
        scope.launch { runCatching { post(LiveBufferLogic.CLEAR_PAYLOAD) } }
    }

    companion object {
        const val DEBOUNCE_MS = 400L
    }
}

/** Pure helpers for the live-buffer payload — unit-tested. */
object LiveBufferLogic {
    const val CLEAR_PAYLOAD = "{}"
    /** Hub caps `selection` at 2000 chars; trim client-side so a whole-doc
     *  select doesn't ship the document twice. */
    const val SELECTION_MAX = 2000

    /** 1-based line holding [caret] (CM6 `doc.lineAt(head).number`). */
    fun cursorLine(text: String, caret: Int): Int {
        val c = caret.coerceIn(0, text.length)
        var line = 1
        for (i in 0 until c) if (text[i] == '\n') line++
        return line
    }

    /** Selected text, or null for an empty selection. */
    fun selectionText(text: String, start: Int, end: Int): String? {
        val a = minOf(start, end).coerceIn(0, text.length)
        val b = maxOf(start, end).coerceIn(0, text.length)
        if (a == b) return null
        return text.substring(a, b).take(SELECTION_MAX)
    }

    fun payload(path: String, content: String, cursorLine: Int?, selection: String?): String =
        buildJsonObject {
            put("path", path)
            put("content", content)
            cursorLine?.let { put("cursorLine", it) }
            selection?.takeIf { it.isNotEmpty() }?.let { put("selection", it) }
        }.toString()
}
