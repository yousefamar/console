package io.amar.console.ui.longtail

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.amar.console.core.HubConfig
import io.amar.console.data.longtail.DashboardAlert
import io.amar.console.data.longtail.HomeRepository
import io.amar.console.data.longtail.formatUptime
import io.amar.console.data.longtail.parseDashboardAlerts
import io.amar.console.data.longtail.parseDashboardSnapshot

// ---------------------------------------------------------------------- //
// Home — real servers + alerts cards from /dashboard, canvas WebView below

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HomeScreen(repo: HomeRepository, onOpenAgentSession: (String) -> Unit = {}, onGrid: () -> Unit = {}) {
    val snapshot by repo.snapshot.collectAsState()

    // Auto-refresh every 30s while the pane is visible (LaunchedEffect dies
    // with composition, so leaving Home stops the loop).
    LaunchedEffect(Unit) {
        while (true) {
            repo.refresh()
            kotlinx.coroutines.delay(30_000)
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        snapshot?.let { snap ->
            val servers = remember(snap.serversJson) { parseDashboardSnapshot(snap.serversJson) }
            val alerts = remember(snap.alertsJson) { parseDashboardAlerts(snap.alertsJson) }

            AlertsCard(alerts, onOpenAgentSession)
            ServersCard(servers)
        } ?: Text(
            "Loading dashboard…",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(12.dp),
        )
        // Canvas island: the ONE place agent-authored HTML renders — a
        // sandboxed WebView loading the hub's canvas page. Online-only.
        AndroidView(
            modifier = Modifier.fillMaxWidth().height(420.dp),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true // canvas content relies on JS
                    settings.domStorageEnabled = false
                    settings.allowFileAccess = false
                    setBackgroundColor(android.graphics.Color.parseColor("#0a0a0a"))
                    loadUrl("${HubConfig.hubBase.removeSuffix("/hub")}/hub/canvas/index.html")
                }
            },
        )
    }
}

@Composable
private fun StatusDot(ok: Boolean) {
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(if (ok) Color(0xFF4ADE80) else Color(0xFFF87171)),
    )
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
    )
}

@Composable
private fun ServersCard(snap: io.amar.console.data.longtail.DashboardSnapshot) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Servers", style = MaterialTheme.typography.titleSmall)
        snap.hub?.let { hub ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(true)
                Text("Hub", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                Text(
                    "up ${formatUptime(hub.uptimeMs)} · ${hub.sessions} sessions",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (snap.tailscale.isNotEmpty()) {
            SectionHeader("Tailscale")
            for (peer in snap.tailscale) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(peer.online)
                    Text(
                        peer.hostname + (if (peer.self) " (this hub)" else ""),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    peer.os?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (snap.pm2.isNotEmpty()) {
            SectionHeader("PM2")
            for (proc in snap.pm2) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(proc.status == "online")
                    Text(proc.name, style = MaterialTheme.typography.bodySmall)
                    Text(
                        "${proc.status} · ${proc.memoryMb} MB",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        if (snap.external.isNotEmpty()) {
            SectionHeader("External")
            for (ext in snap.external) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(ext.ok)
                    Text(ext.name, style = MaterialTheme.typography.bodySmall)
                    Text(
                        ext.latencyMs?.let { "${it}ms" } ?: ext.error ?: "",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun AlertsCard(alerts: List<DashboardAlert>, onOpenAgentSession: (String) -> Unit) {
    if (alerts.isEmpty()) return
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Alerts", style = MaterialTheme.typography.titleSmall)
        for (alert in alerts.take(12)) {
            when (alert) {
                is DashboardAlert.Approval -> Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenAgentSession(alert.sessionId) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("⚠", style = MaterialTheme.typography.bodySmall)
                    Column(Modifier.weight(1f)) {
                        Text(
                            "${alert.sessionName ?: alert.sessionId.take(8)} · ${alert.toolName}",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                        )
                        alert.question?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                is DashboardAlert.Upcoming -> {
                    val inMin = ((alert.startMs - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("📅", style = MaterialTheme.typography.bodySmall)
                        Text(alert.summary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "in ${inMin}m",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                }
                is DashboardAlert.Err -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("✕", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Text(
                        alert.message,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
