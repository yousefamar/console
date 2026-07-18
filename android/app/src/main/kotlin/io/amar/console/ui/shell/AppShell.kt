package io.amar.console.ui.shell

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import io.amar.console.ConsoleApp
import io.amar.console.R
import io.amar.console.core.AppLifecycle
import io.amar.console.ui.chat.ChatRoomListScreen
import io.amar.console.ui.chat.ChatRoomScreen
import io.amar.console.ui.nav.Pane
import io.amar.console.ui.panes.PlaceholderPane
import io.amar.console.ui.settings.SettingsScreen

/**
 * The app shell: NavHost + bottom pane bar + offline banner + outbox chip.
 * Panes register their real screens per milestone; anything not yet built
 * renders a PlaceholderPane.
 */
@Composable
fun AppShell(app: ConsoleApp, navController: NavHostController) {
    val connected by app.graph.syncBus.connectedFlow.collectAsState()
    val backlog by app.graph.db.outbox().observeBacklogCount().collectAsState(initial = 0)
    val update by io.amar.console.core.Updater.available.collectAsState()

    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route ?: Pane.Chat.route
    // Feed the RESOLVED route (args substituted) to AppLifecycle so
    // PushService can suppress notifications for the visible room/thread.
    AppLifecycle.currentRoute = when {
        currentRoute.startsWith("chat/") -> {
            val roomId = backStack?.arguments?.getString("roomId")
            if (roomId != null) "chat/${android.net.Uri.decode(roomId)}" else currentRoute
        }
        else -> currentRoute
    }

    var showOverflow by remember { mutableStateOf(false) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                for (pane in Pane.primary) {
                    NavigationBarItem(
                        selected = currentRoute.startsWith(pane.route),
                        onClick = {
                            showOverflow = false
                            navController.navigate(pane.route) {
                                popUpTo(navController.graph.startDestinationId) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(pane.icon, contentDescription = pane.label) },
                        label = { Text(pane.label) },
                    )
                }
                NavigationBarItem(
                    selected = showOverflow || Pane.overflow.any { currentRoute.startsWith(it.route) },
                    onClick = { showOverflow = !showOverflow },
                    icon = { Icon(Icons.Outlined.MoreHoriz, contentDescription = stringResource(R.string.more)) },
                    label = { Text(stringResource(R.string.more)) },
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (!connected) {
                StatusBanner(
                    icon = Icons.Outlined.CloudOff,
                    text = if (backlog > 0) "Offline — $backlog queued" else "Offline — showing cached data",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (backlog > 0) {
                StatusBanner(text = "Syncing $backlog queued…", tint = MaterialTheme.colorScheme.primary)
            }
            update?.let { u ->
                UpdateBanner(
                    versionName = u.versionName,
                    onInstall = { io.amar.console.core.Updater.downloadAndInstall(app, u.url) },
                    onDismiss = { io.amar.console.core.Updater.dismiss() },
                )
            }
            if (showOverflow) {
                OverflowRow(
                    onSelect = { pane ->
                        showOverflow = false
                        navController.navigate(pane.route) {
                            popUpTo(navController.graph.startDestinationId) { saveState = true }
                            launchSingleTop = true
                            restoreState = true
                        }
                    },
                    onSettings = {
                        showOverflow = false
                        navController.navigate("settings") { launchSingleTop = true }
                    },
                )
            }

            NavHost(
                navController = navController,
                startDestination = Pane.Chat.route,
                modifier = Modifier.fillMaxSize(),
            ) {
                composable(Pane.Chat.route) {
                    ChatRoomListScreen(app.graph.chat, onOpenRoom = { roomId ->
                        navController.navigate("chat/${android.net.Uri.encode(roomId)}")
                    })
                }
                composable("chat/{roomId}") { entry ->
                    val roomId = android.net.Uri.decode(entry.arguments?.getString("roomId") ?: "")
                    ChatRoomScreen(app.graph.chat, roomId)
                }
                for (pane in Pane.entries.filter { it != Pane.Chat }) {
                    composable(pane.route) { PlaceholderPane(pane) }
                }
                composable("settings") { SettingsScreen(app) }
            }
        }
    }
}
