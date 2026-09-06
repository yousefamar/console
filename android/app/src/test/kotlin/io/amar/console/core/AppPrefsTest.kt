package io.amar.console.core

import io.amar.console.core.AppPrefs.ThemeMode
import io.amar.console.ui.nav.Pane
import io.amar.console.ui.shell.LEGACY_PANES
import io.amar.console.ui.shell.visibleGridPanes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppPrefsTest {
    @Test
    fun `resolveDark - override wins, SYSTEM defers to the OS`() {
        assertTrue(AppPrefs.resolveDark(ThemeMode.SYSTEM, systemDark = true))
        assertFalse(AppPrefs.resolveDark(ThemeMode.SYSTEM, systemDark = false))
        assertTrue(AppPrefs.resolveDark(ThemeMode.DARK, systemDark = false))
        assertFalse(AppPrefs.resolveDark(ThemeMode.LIGHT, systemDark = true))
    }

    @Test
    fun `parseThemeMode - case-insensitive, garbage falls back to SYSTEM`() {
        assertEquals(ThemeMode.LIGHT, AppPrefs.parseThemeMode("LIGHT"))
        assertEquals(ThemeMode.DARK, AppPrefs.parseThemeMode("dark"))
        assertEquals(ThemeMode.SYSTEM, AppPrefs.parseThemeMode(null))
        assertEquals(ThemeMode.SYSTEM, AppPrefs.parseThemeMode("purple"))
    }

    @Test
    fun `visibleGridPanes - hide-legacy prunes only the unsearched grid`() {
        val all = visibleGridPanes("", hideLegacy = false)
        assertEquals(Pane.entries.toList(), all)

        val pruned = visibleGridPanes("", hideLegacy = true)
        assertTrue(pruned.none { it in LEGACY_PANES })
        assertEquals(Pane.entries.size - LEGACY_PANES.size, pruned.size)
        // Order is preserved for the survivors.
        assertEquals(Pane.entries.filter { it !in LEGACY_PANES }, pruned)

        // A search still reaches a hidden tile.
        assertEquals(listOf(Pane.Mail), visibleGridPanes("mai", hideLegacy = true))
        assertEquals(listOf(Pane.Chat), visibleGridPanes("CHAT", hideLegacy = true))
    }
}
