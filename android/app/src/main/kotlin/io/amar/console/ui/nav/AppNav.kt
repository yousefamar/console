package io.amar.console.ui.nav

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Navigation architecture — app-grid launcher + strict surface hierarchy.
 *
 *   L0  "grid"          launcher (start destination; badges, status, update)
 *   L1  "<app>"         app root (list/main screen; grid glyph top-left)
 *   L2  "<app>/<id>"    detail (back → app root, never sideways)
 *   Sheets              item-contextual actions/pickers (ModalBottomSheet)
 *   Dialogs             single-purpose input (compose/create/rename)
 *   Overlays            lightbox only
 *
 * Invariants:
 *  - Back is linear: detail → root → grid → system exit. No cross-app jumps.
 *  - App switching goes through the grid; per-app stack state is
 *    saved/restored (popUpTo(GRID) { saveState }).
 *  - Deep links build the REAL stack (grid → root → detail) so back from a
 *    notification-opened detail lands on the app root, not out of the app.
 */
const val GRID_ROUTE = "grid"

/** App registry — every tile on the launcher, in grid order. */
enum class Pane(
    val route: String,
    val label: String,
    val icon: ImageVector,
) {
    Chat("chat", "Chat", Icons.AutoMirrored.Outlined.Chat),
    Mail("mail", "Mail", Icons.Outlined.Email),
    Agents("agents", "Agents", Icons.Outlined.SmartToy),
    Calendar("calendar", "Calendar", Icons.Outlined.CalendarMonth),
    Notes("notes", "Notes", Icons.Outlined.StickyNote2),
    Feeds("feeds", "Feeds", Icons.Outlined.RssFeed),
    Bookmarks("bookmarks", "Bookmarks", Icons.Outlined.Bookmarks),
    Map("map", "Map", Icons.Outlined.Map),
    Home("home", "Dashboard", Icons.Outlined.Home),
    Music("music", "Music", Icons.Outlined.MusicNote),
    Settings("settings", "Settings", Icons.Outlined.Settings),
    ;

    companion object {
        fun fromRoute(route: String): Pane? = entries.firstOrNull { it.route == route }

        /** Map hub push `pane` values (e.g. "email" legacy) onto panes. */
        fun fromPushPane(pane: String): Pane = when (pane) {
            "email" -> Mail
            "money" -> Home // Money pane is out of scope; land somewhere sane
            else -> fromRoute(pane) ?: Home
        }
    }
}
