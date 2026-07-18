package io.amar.console.ui.nav

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.StickyNote2
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Pane registry — mirrors the SPA's ActivePane set (minus Money, per scope).
 * `route` doubles as the deep-link pane name (`console://pane/<route>`), so
 * the hub's existing PushMessage pane values map 1:1.
 */
enum class Pane(
    val route: String,
    val label: String,
    val icon: ImageVector,
) {
    Home("home", "Home", Icons.Outlined.Home),
    Chat("chat", "Chat", Icons.AutoMirrored.Outlined.Chat),
    Mail("mail", "Mail", Icons.Outlined.Email),
    Calendar("calendar", "Calendar", Icons.Outlined.CalendarMonth),
    Notes("notes", "Notes", Icons.Outlined.StickyNote2),
    Feeds("feeds", "Feeds", Icons.Outlined.RssFeed),
    Agents("agents", "Agents", Icons.Outlined.SmartToy),
    Bookmarks("bookmarks", "Bookmarks", Icons.Outlined.Bookmarks),
    Map("map", "Map", Icons.Outlined.Map),
    ;

    companion object {
        /** Panes surfaced in the bottom bar (the rest live in the overflow row). */
        val primary = listOf(Chat, Mail, Calendar, Notes, Agents)
        val overflow = listOf(Home, Feeds, Bookmarks, Map)

        fun fromRoute(route: String): Pane? = entries.firstOrNull { it.route == route }

        /** Map hub push `pane` values (e.g. "email" legacy) onto panes. */
        fun fromPushPane(pane: String): Pane = when (pane) {
            "email" -> Mail
            "money" -> Home // Money pane is out of scope; land somewhere sane
            else -> fromRoute(pane) ?: Home
        }
    }
}
