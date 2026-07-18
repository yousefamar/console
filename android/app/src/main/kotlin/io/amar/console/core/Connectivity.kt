package io.amar.console.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Network-availability signal. One of the three reconcile triggers (WS
 * connect, app foreground, network regained) — mirrors the SPA's
 * `window.online` listener in useSync.ts.
 */
object Connectivity {
    private val _online = MutableStateFlow(false)
    val onlineFlow: StateFlow<Boolean> = _online
    val online: Boolean get() = _online.value

    fun install(context: Context) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        // Seed from current state — callbacks only fire on change.
        val active = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        _online.value = active?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _online.value = true
            }

            override fun onLost(network: Network) {
                // Another network may still be up; re-check instead of assuming.
                val current = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
                _online.value = current?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            }
        })
    }
}
