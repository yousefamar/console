package io.amar.console.ui.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
    data class UndoAction(val label: String, val expiresAt: Long, val undo: suspend () -> Unit)

    private val _action = MutableStateFlow<UndoAction?>(null)
    val action: StateFlow<UndoAction?> = _action

    /** Offer an undo for [label]; auto-expires after [ttlMs] (default 5s). */
    fun offer(label: String, ttlMs: Long = 5_000, undo: suspend () -> Unit) {
        _action.value = UndoAction(label, System.currentTimeMillis() + ttlMs, undo)
    }

    fun clear() { _action.value = null }
}

/** The bottom-center undo snackbar; renders whenever [UndoController] has a live
 *  action, auto-dismisses at expiry. Mounted once in AppShell. */
@Composable
fun UndoHost(scope: CoroutineScope, modifier: Modifier = Modifier) {
    val action by UndoController.action.collectAsState()
    action?.let { a ->
        // Auto-dismiss at expiry (keyed on the action instance).
        LaunchedEffect(a) {
            val wait = a.expiresAt - System.currentTimeMillis()
            if (wait > 0) delay(wait)
            if (UndoController.action.value === a) UndoController.clear()
        }
        Box(modifier.fillMaxWidth()) {
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp),
                action = {
                    TextButton(onClick = {
                        scope.launch { runCatching { a.undo() } }
                        UndoController.clear()
                    }) { Text("Undo") }
                },
            ) { Text(a.label) }
        }
    }
}
