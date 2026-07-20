package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Home dashboard — last-known snapshot render; canvas is a WebView island. */
class HomeRepository(private val hub: HubClient) {
    data class Snapshot(val serversJson: String, val alertsJson: String, val fetchedAt: Long)

    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    val snapshot: StateFlow<Snapshot?> = _snapshot

    suspend fun refresh() {
        val servers = runCatching { hub.get("/dashboard/snapshot") }.getOrNull()
        val alerts = runCatching { hub.get("/dashboard/alerts") }.getOrNull()
        if (servers != null || alerts != null) {
            _snapshot.value = Snapshot(
                serversJson = servers ?: _snapshot.value?.serversJson ?: "{}",
                alertsJson = alerts ?: _snapshot.value?.alertsJson ?: "{}",
                fetchedAt = System.currentTimeMillis(),
            )
        }
    }
}
