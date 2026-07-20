package io.amar.console.ui.shell

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import io.amar.console.ConsoleApp
import io.amar.console.core.AppLifecycle
import io.amar.console.ui.agents.AgentSessionListScreen
import io.amar.console.ui.agents.AgentSessionScreen
import io.amar.console.ui.cal.CalendarScreen
import io.amar.console.ui.chat.ChatRoomListScreen
import io.amar.console.ui.chat.ChatRoomScreen
import io.amar.console.ui.feeds.FeedItemScreen
import io.amar.console.ui.feeds.FeedsScreen
import io.amar.console.ui.longtail.BookmarksScreen
import io.amar.console.ui.longtail.HomeScreen
import io.amar.console.ui.longtail.MapScreen
import io.amar.console.ui.longtail.MusicScreen
import io.amar.console.ui.mail.MailInboxScreen
import io.amar.console.ui.mail.MailThreadScreen
import io.amar.console.ui.nav.GRID_ROUTE
import io.amar.console.ui.nav.Pane
import io.amar.console.ui.notes.NoteEditorScreen
import io.amar.console.ui.notes.NotesBrowserScreen
import io.amar.console.ui.settings.HardwareSettingsScreen
import io.amar.console.ui.settings.SettingsScreen

/**
 * The app shell — app-grid navigation architecture (see ui/nav/AppNav.kt for
 * the full hierarchy contract).
 *
 *   grid (L0) → app root (L1) → detail (L2)
 *
 * There is NO bottom bar and NO overflow row: the grid is the only switcher.
 * Every L1 screen shows a grid glyph in its top bar (wired via PaneTopBar's
 * onGrid); back pops linearly. Banners (offline/queued/update) render above
 * the NavHost on every surface. Sheets/dialogs stay inside their screens.
 */
@Composable
fun AppShell(app: ConsoleApp, navController: NavHostController) {
    val connected by app.graph.syncBus.connectedFlow.collectAsState()
    val pendingCount by app.graph.db.outbox().observePendingCount().collectAsState(initial = 0)
    val stuckCount by app.graph.db.outbox().observeStuckCount().collectAsState(initial = 0)
    val update by io.amar.console.core.Updater.available.collectAsState()
    val authExpired by io.amar.console.core.AuthState.expired.collectAsState()

    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route ?: GRID_ROUTE
    // Feed the RESOLVED route (args substituted) to AppLifecycle so
    // PushService can suppress notifications for the visible room/thread.
    AppLifecycle.currentRoute = when {
        currentRoute.startsWith("chat/") -> {
            val roomId = backStack?.arguments?.getString("roomId")
            if (roomId != null) "chat/${android.net.Uri.decode(roomId)}" else currentRoute
        }
        currentRoute.startsWith("agents/") -> {
            val sid = backStack?.arguments?.getString("sessionId")
            if (sid != null) "agents/${android.net.Uri.decode(sid)}" else currentRoute
        }
        else -> currentRoute
    }
    // Route change → re-render the glasses mirror (no-op when disabled).
    app.graph.mirror.poke()

    // Remote debug nav hooks: `nav <route>` / `back` from the hub /debug RPC.
    androidx.compose.runtime.DisposableEffect(navController) {
        io.amar.console.core.DebugAgent.navigate = { route ->
            runCatching {
                if (route == GRID_ROUTE) navController.navigateToGrid()
                else navController.navigate(route) { launchSingleTop = true }
            }.isSuccess
        }
        io.amar.console.core.DebugAgent.goBack = { navController.popBackStack() }
        onDispose {
            io.amar.console.core.DebugAgent.navigate = null
            io.amar.console.core.DebugAgent.goBack = null
        }
    }

    // Grid navigation helper shared by every L1 top bar.
    val toGrid: () -> Unit = { navController.navigateToGrid() }

    val shellScope = androidx.compose.runtime.rememberCoroutineScope()
    Scaffold { padding ->
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
        Column(
            Modifier.fillMaxSize()
        ) {
            // Banner semantics: "Syncing" only for rows that will actually
            // drain (pending/processing). failed/conflict rows show as "need
            // attention" instead of an eternal never-decrementing "Syncing N".
            // Both are tappable → outbox inspector, so the count is explorable.
            val toOutbox: () -> Unit = { navController.navigate("settings/outbox") { launchSingleTop = true } }
            if (!connected) {
                StatusBanner(
                    icon = Icons.Outlined.CloudOff,
                    text = if (pendingCount > 0) "Offline — $pendingCount queued" else "Offline",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    onClick = if (pendingCount > 0) toOutbox else null,
                )
            } else if (pendingCount > 0) {
                StatusBanner(
                    text = "Syncing $pendingCount…",
                    tint = MaterialTheme.colorScheme.primary,
                    onClick = toOutbox,
                )
            } else if (stuckCount > 0) {
                StatusBanner(
                    text = "$stuckCount ${if (stuckCount == 1) "action" else "actions"} failed — tap to review",
                    tint = MaterialTheme.colorScheme.error,
                    onClick = toOutbox,
                )
            }
            update?.let { u ->
                UpdateBanner(
                    versionName = u.versionName,
                    onInstall = { io.amar.console.core.Updater.downloadAndInstall(app, u.url) },
                    onDismiss = { io.amar.console.core.Updater.dismiss() },
                )
            }
            if (authExpired) {
                // Foreground re-pair prompt (a dead bearer surfaced as 401/403).
                // Tapping opens Settings, where pairing lives.
                ReAuthBanner(onFix = { navController.openApp(Pane.Settings) })
            }

            NavHost(
                navController = navController,
                startDestination = GRID_ROUTE,
                modifier = Modifier.fillMaxSize(),
                // Instant switches — navigation-compose defaults to a cross-fade
                // on every push/pop, which reads as lag on each tap.
                enterTransition = { androidx.compose.animation.EnterTransition.None },
                exitTransition = { androidx.compose.animation.ExitTransition.None },
                popEnterTransition = { androidx.compose.animation.EnterTransition.None },
                popExitTransition = { androidx.compose.animation.ExitTransition.None },
            ) {
                // L0 — launcher
                composable(GRID_ROUTE) {
                    GridScreen(app, onOpen = { pane -> navController.openApp(pane) })
                }

                // L1 roots + L2 details, one pair per app.
                composable(Pane.Chat.route) {
                    ChatRoomListScreen(
                        app.graph.chat,
                        onOpenRoom = { roomId -> navController.navigate("chat/${android.net.Uri.encode(roomId)}") },
                        onGrid = toGrid,
                    )
                }
                composable("chat/{roomId}") { entry ->
                    val roomId = android.net.Uri.decode(entry.arguments?.getString("roomId") ?: "")
                    ChatRoomScreen(
                        app.graph.chat, roomId,
                        onBack = { navController.popBackStack() },
                        onComposerChange = { app.graph.mirror.setComposerText(it) },
                    )
                }
                composable(Pane.Mail.route) {
                    MailInboxScreen(
                        app.graph.mail,
                        onOpenThread = { threadId -> navController.navigate("mail/${android.net.Uri.encode(threadId)}") },
                        onGrid = toGrid,
                    )
                }
                composable("mail/{threadId}") { entry ->
                    val threadId = android.net.Uri.decode(entry.arguments?.getString("threadId") ?: "")
                    MailThreadScreen(
                        app.graph.mail, threadId,
                        onBack = { navController.popBackStack() },
                        onRemovedWithUndo = { id, kind ->
                            UndoController.offer(if (kind == "delete") "Deleted" else "Archived") {
                                if (kind == "delete") app.graph.mail.undoDelete(id) else app.graph.mail.undoArchive(id)
                            }
                        },
                    )
                }
                composable(Pane.Agents.route) {
                    AgentSessionListScreen(
                        app.graph.agents,
                        onOpenSession = { sessionId -> navController.navigate("agents/${android.net.Uri.encode(sessionId)}") },
                        onGrid = toGrid,
                    )
                }
                composable("agents/{sessionId}") { entry ->
                    val sessionId = android.net.Uri.decode(entry.arguments?.getString("sessionId") ?: "")
                    AgentSessionScreen(
                        app.graph.agents, sessionId,
                        onBack = { navController.popBackStack() },
                        onComposerChange = { app.graph.mirror.setComposerText(it) },
                    )
                }
                composable(Pane.Calendar.route) { CalendarScreen(app.graph.calendar, onGrid = toGrid) }
                composable(Pane.Notes.route) {
                    NotesBrowserScreen(
                        app.graph.notes,
                        onOpenFile = { path -> navController.navigate("notes/${android.net.Uri.encode(path)}") },
                        onGrid = toGrid,
                    )
                }
                composable("notes/{path}") { entry ->
                    val path = android.net.Uri.decode(entry.arguments?.getString("path") ?: "")
                    NoteEditorScreen(
                        app.graph.notes, path,
                        onBack = { navController.popBackStack() },
                        agents = app.graph.agents,
                        onOpenAgentSession = { sessionId ->
                            navController.openApp(Pane.Agents)
                            navController.navigate("agents/${android.net.Uri.encode(sessionId)}")
                        },
                        mirror = app.graph.mirror,
                    )
                }
                composable(Pane.Feeds.route) {
                    FeedsScreen(
                        app.graph.feeds,
                        onOpenItem = { itemId -> navController.navigate("feeds/${android.net.Uri.encode(itemId)}") },
                        onGrid = toGrid,
                    )
                }
                composable("feeds/{itemId}") { entry ->
                    val itemId = android.net.Uri.decode(entry.arguments?.getString("itemId") ?: "")
                    FeedItemScreen(app.graph.feeds, itemId, onBack = { navController.popBackStack() })
                }
                composable(Pane.Bookmarks.route) { BookmarksScreen(app.graph.bookmarks, onGrid = toGrid) }
                composable(Pane.Map.route) { MapScreen(app.graph.map, onGrid = toGrid) }
                composable(Pane.Home.route) {
                    HomeScreen(
                        app.graph.home,
                        onOpenAgentSession = { sessionId ->
                            // Cross-app tap-through: build the real stack so
                            // back walks agents-root → grid, not back to Home.
                            navController.openApp(Pane.Agents)
                            navController.navigate("agents/${android.net.Uri.encode(sessionId)}")
                        },
                        onOpenNote = { path ->
                            navController.openApp(Pane.Notes)
                            navController.navigate("notes/${android.net.Uri.encode(path)}")
                        },
                        onGrid = toGrid,
                    )
                }
                composable(Pane.Music.route) { MusicScreen(app.graph.music, onGrid = toGrid) }
                composable(Pane.Settings.route) {
                    SettingsScreen(
                        app, onGrid = toGrid,
                        onHardware = { navController.navigate("settings/hardware") { launchSingleTop = true } },
                        onOutbox = { navController.navigate("settings/outbox") { launchSingleTop = true } },
                    )
                }
                composable("settings/hardware") {
                    HardwareSettingsScreen(app, onBack = { navController.popBackStack() })
                }
                composable("settings/outbox") {
                    io.amar.console.ui.settings.OutboxInspectorScreen(app, onBack = { navController.popBackStack() })
                }
            }
        }
        // App-wide undo affordance (survives detail→list pops).
        UndoHost(shellScope)
        }
    }
}

/** Open an app root from the grid: single top, per-app state restored. */
fun NavHostController.openApp(pane: Pane) {
    navigate(pane.route) {
        popUpTo(GRID_ROUTE) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

/** Return to the launcher, keeping each app's stack state for restoration. */
fun NavHostController.navigateToGrid() {
    navigate(GRID_ROUTE) {
        popUpTo(GRID_ROUTE) { inclusive = false; saveState = true }
        launchSingleTop = true
    }
}
