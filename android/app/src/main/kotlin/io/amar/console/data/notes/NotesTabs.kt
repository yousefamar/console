package io.amar.console.data.notes

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * In-memory multi-file tab model for the notes editor — the mobile analogue of
 * the SPA's `openFiles`/`activeFilePath` store (src/store/notes.ts). Open tabs
 * carry their live + saved buffers so unsaved edits survive tab switches; the
 * open-path list + active path persist to the Room `meta` KV (via
 * [NotesRepository]) so they restore across app restarts. Content buffers are
 * memory-only and re-read on restore.
 *
 * Pure index math lives in [TabsLogic] for unit tests; this class owns the
 * observable state + persistence callback.
 */
class NotesTabs(
    /** Persist the open-path list + active path (Room meta, fire-and-forget). */
    private val persist: (openPaths: List<String>, active: String?) -> Unit = { _, _ -> },
) {
    data class Tab(val path: String, val content: String, val savedContent: String) {
        val dirty: Boolean get() = content != savedContent
    }
    data class State(
        val open: List<Tab> = emptyList(),
        val activePath: String? = null,
        val recentlyClosed: List<String> = emptyList(),
    ) {
        fun tab(path: String): Tab? = open.firstOrNull { it.path == path }
        val activeTab: Tab? get() = activePath?.let { tab(it) }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    /** Open [path] (activating it if already open), else add a new tab. */
    fun open(path: String, content: String) {
        val s = _state.value
        if (s.tab(path) != null) {
            setActive(path)
            return
        }
        val open = s.open + Tab(path, content, content)
        _state.value = s.copy(open = open, activePath = path)
        persist(open.map { it.path }, path)
    }

    fun setActive(path: String) {
        if (_state.value.tab(path) == null) return
        _state.value = _state.value.copy(activePath = path)
        persist(_state.value.open.map { it.path }, path)
    }

    /** Live-edit buffer of a tab (drives the dirty dot). No persistence. */
    fun setContent(path: String, content: String) {
        val s = _state.value
        val tab = s.tab(path) ?: return
        if (tab.content == content) return
        _state.value = s.copy(open = s.open.map { if (it.path == path) it.copy(content = content) else it })
    }

    /** Mark a tab clean (called after a successful save). */
    fun markSaved(path: String, savedContent: String) {
        val s = _state.value
        _state.value = s.copy(open = s.open.map {
            if (it.path == path) it.copy(content = savedContent, savedContent = savedContent) else it
        })
    }

    /**
     * Close [path]. Refuses (returns false) when the tab is dirty and not
     * [force]d — the caller shows a confirm. Picks the next active tab: same
     * index, else previous, else first remaining, else none.
     */
    fun close(path: String, force: Boolean = false): Boolean {
        val s = _state.value
        val tab = s.tab(path) ?: return true
        if (!force && tab.dirty) return false

        val paths = s.open.map { it.path }
        val idx = paths.indexOf(path)
        val remaining = s.open.filter { it.path != path }
        val newActive = if (s.activePath == path) TabsLogic.nextActive(paths, idx) else s.activePath
        val validActive = if (newActive != null && remaining.any { it.path == newActive }) newActive
        else remaining.firstOrNull()?.path
        val closed = (listOf(path) + s.recentlyClosed).distinct().take(20)
        _state.value = State(remaining, validActive, closed)
        persist(remaining.map { it.path }, validActive)
        return true
    }

    fun closeAll() {
        val s = _state.value
        val closed = (s.open.map { it.path } + s.recentlyClosed).distinct().take(20)
        _state.value = State(emptyList(), null, closed)
        persist(emptyList(), null)
    }

    /** Update tab paths after a rename (keeps unsaved content + active state). */
    fun renamed(from: String, to: String) {
        val s = _state.value
        if (s.tab(from) == null) return
        val open = s.open.map { if (it.path == from) it.copy(path = to) else it }
        val active = if (s.activePath == from) to else s.activePath
        _state.value = s.copy(open = open, activePath = active)
        persist(open.map { it.path }, active)
    }

    /** Reopen the most-recently-closed path not already open; null if none. */
    fun reopenLastClosed(): String? {
        val s = _state.value
        val toReopen = s.recentlyClosed.firstOrNull { p -> s.open.none { it.path == p } } ?: return null
        _state.value = s.copy(recentlyClosed = s.recentlyClosed.filter { it != toReopen })
        return toReopen
    }

    fun nextTab() {
        val s = _state.value
        val paths = s.open.map { it.path }
        val next = TabsLogic.cycle(paths, s.activePath, +1) ?: return
        setActive(next)
    }

    fun prevTab() {
        val s = _state.value
        val paths = s.open.map { it.path }
        val prev = TabsLogic.cycle(paths, s.activePath, -1) ?: return
        setActive(prev)
    }
}

/** Pure index math for the tab model — unit-tested independently. */
object TabsLogic {
    /** Active path after closing the tab at [idx]: next, else previous, else null. */
    fun nextActive(pathsBeforeClose: List<String>, idx: Int): String? {
        pathsBeforeClose.getOrNull(idx + 1)?.let { return it }
        pathsBeforeClose.getOrNull(idx - 1)?.let { return it }
        return null
    }

    /** Cycle from [active] by [dir] (±1), wrapping; null when ≤1 tab. */
    fun cycle(paths: List<String>, active: String?, dir: Int): String? {
        if (paths.size <= 1) return null
        val idx = paths.indexOf(active ?: "")
        val base = if (idx < 0) 0 else idx
        val n = paths.size
        return paths[((base + dir) % n + n) % n]
    }
}
