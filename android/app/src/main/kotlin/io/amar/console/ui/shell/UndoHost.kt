package io.amar.console.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * App-wide undo slot — the native twin of the SPA's single `undoAction`
 * (src/store/ui.ts). One destructive action at a time gets a 5-second "Undo"
 * affordance surfaced at the shell level, so an action taken inside a DETAIL
 * screen (e.g. a mail thread-view archive/delete that navigates back) still
 * shows its undo at the list level (FEATURES app-wide #49, mail #99).
 *
 * Deliberately a process-wide singleton: the toast host lives in AppShell,
 * above the NavHost, so it survives the detail→root pop that follows the
 * action.
 */
object UndoController {
    data class UndoAction(
        val label: String,
        val expiresAt: Long,
        /** Runs once if the window elapses WITHOUT undo (cleanup hook). */
        val onExpire: (suspend () -> Unit)? = null,
        val undo: suspend () -> Unit,
    )

    private val _action = MutableStateFlow<UndoAction?>(null)
    val action: StateFlow<UndoAction?> = _action

    /** Offer an undo for [label]; auto-expires after [ttlMs] (default 5s). */
    fun offer(label: String, ttlMs: Long = 5_000, onExpire: (suspend () -> Unit)? = null, undo: suspend () -> Unit) {
        _action.value = UndoAction(label, System.currentTimeMillis() + ttlMs, onExpire, undo)
    }

    fun clear() { _action.value = null }
}

/**
 * App-wide toast slot with an optional click-through URL — the native twin of
 * the SPA's toast `href` support (FEATURES app-wide #47, e.g. a published
 * blog-post permalink). Errors linger 8s, others 4s (SPA store.ts TTLs).
 * Single-slot, shell-hosted; distinct from the undo slot.
 */
object AppToast {
    data class Toast(val message: String, val href: String?, val expiresAt: Long)

    private val _toast = MutableStateFlow<Toast?>(null)
    val toast: StateFlow<Toast?> = _toast

    fun show(message: String, href: String? = null, error: Boolean = false) {
        val ttl = if (error) 8_000L else 4_000L
        _toast.value = Toast(message, href, System.currentTimeMillis() + ttl)
    }

    fun clear() { _toast.value = null }
}

/** Compact bottom-center toast pill — the chat "Marked read / UNDO" look:
 *  wrap-content rounded chip on inverseSurface, NOT a full-width Material
 *  snackbar bar. One style for every tab. */
@Composable
private fun ToastPill(message: String, actionLabel: String?, onAction: () -> Unit) {
    Row(
        Modifier
            .padding(16.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.inverseSurface)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            message, style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.inverseOnSurface,
        )
        if (actionLabel != null) {
            Text(
                actionLabel,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.inversePrimary,
                modifier = Modifier.clickable(onClick = onAction),
            )
        }
    }
}

/** The bottom-center undo pill + app toast; each renders whenever its
 *  controller has a live entry, auto-dismisses at expiry. Mounted once in
 *  AppShell. */
@Composable
fun UndoHost(scope: CoroutineScope, modifier: Modifier = Modifier) {
    val action by UndoController.action.collectAsState()
    val toast by AppToast.toast.collectAsState()
    val context = LocalContext.current
    Box(modifier.fillMaxWidth()) {
        Column(
            Modifier.align(Alignment.BottomCenter),
            horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
        ) {
            toast?.let { t ->
                LaunchedEffect(t) {
                    val wait = t.expiresAt - System.currentTimeMillis()
                    if (wait > 0) delay(wait)
                    if (AppToast.toast.value === t) AppToast.clear()
                }
                ToastPill(t.message, actionLabel = t.href?.let { "OPEN" }) {
                    t.href?.let { href ->
                        runCatching {
                            context.startActivity(
                                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(href))
                                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                    }
                    AppToast.clear()
                }
            }
            action?.let { a ->
                // Auto-dismiss at expiry (keyed on the action instance).
                LaunchedEffect(a) {
                    val wait = a.expiresAt - System.currentTimeMillis()
                    if (wait > 0) delay(wait)
                    if (UndoController.action.value === a) {
                        UndoController.clear()
                        a.onExpire?.let { runCatching { it() } }
                    }
                }
                ToastPill(a.label, actionLabel = "UNDO") {
                    scope.launch { runCatching { a.undo() } }
                    UndoController.clear()
                }
            }
        }
    }
}
