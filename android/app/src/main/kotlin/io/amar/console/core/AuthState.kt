package io.amar.console.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Global auth-health signal — the native twin of the SPA's `authPending`
 * (src/hub.ts) / `needsReAuth` (src/store/ui.ts). HubClient flips [expired]
 * true when a foreground REST call to the hub returns 401/403 (a dead bearer
 * on this deployment — there is no cookie challenge for the APK), and clears
 * it on the next successful response. The shell (AppShell) subscribes and
 * shows an in-app "session expired — re-pair" banner instead of failing
 * silently with stale data (FEATURES app-wide #30, mail #69).
 *
 * PushService already posts a background "re-pair needed" notification on a
 * WS 4401/4403 or handshake 401/403; this is the foreground, in-app surface.
 */
object AuthState {
    private val _expired = MutableStateFlow(false)
    val expired: StateFlow<Boolean> = _expired

    fun markExpired() {
        if (!_expired.value) _expired.value = true
    }

    /** Any authenticated 2xx clears the flag. */
    fun markHealthy() {
        if (_expired.value) _expired.value = false
    }
}
