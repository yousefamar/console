package io.amar.console.core

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Process-wide foreground signal. Replaces the WebView-era
 * `MainActivity.foreground` static that PushService read to route PTT
 * transcripts (compose into the visible composer vs auto-send).
 *
 * `currentRoute` additionally tracks which pane/item the user is looking at,
 * so PushService can skip posting a notification for the room/thread that is
 * open on screen right now.
 */
object AppLifecycle : DefaultLifecycleObserver {
    private val _foreground = MutableStateFlow(false)
    val foregroundFlow: StateFlow<Boolean> = _foreground
    val foreground: Boolean get() = _foreground.value

    /** e.g. "chat/!roomid:server", "mail/thread123", "notes". Set by AppNav. */
    @Volatile var currentRoute: String = ""

    fun install() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    override fun onStart(owner: LifecycleOwner) {
        _foreground.value = true
    }

    override fun onStop(owner: LifecycleOwner) {
        _foreground.value = false
    }

    /** True when the user is actively viewing the given pane+item. */
    fun isViewing(pane: String, itemId: String?): Boolean {
        if (!foreground) return false
        val route = currentRoute
        if (itemId.isNullOrEmpty()) return route == pane || route.startsWith("$pane/")
        return route == "$pane/$itemId"
    }
}
