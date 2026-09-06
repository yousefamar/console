package io.amar.console.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Device-local UI preferences — things that legitimately differ per device
 * and so are NOT hub prefs: the phone is read outdoors in sunlight while the
 * desktop sits in a dark room, and the SPA's `console:ui:legacyTabs` is
 * localStorage too. Same init pattern as [HubConfig].
 */
object AppPrefs {
    private const val PREFS = "app_prefs"
    private const val KEY_THEME = "themeMode"
    private const val KEY_HIDE_LEGACY = "hideLegacyTiles"

    enum class ThemeMode { SYSTEM, DARK, LIGHT }

    @Volatile private var prefs: SharedPreferences? = null

    private val _themeMode = MutableStateFlow(ThemeMode.SYSTEM)
    val themeMode: StateFlow<ThemeMode> = _themeMode

    private val _hideLegacyTiles = MutableStateFlow(false)
    val hideLegacyTiles: StateFlow<Boolean> = _hideLegacyTiles

    /** Idempotent; safe from any process entry point. */
    fun init(context: Context) {
        if (prefs != null) return
        synchronized(this) {
            if (prefs != null) return
            val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            prefs = p
            _themeMode.value = parseThemeMode(p.getString(KEY_THEME, null))
            _hideLegacyTiles.value = p.getBoolean(KEY_HIDE_LEGACY, false)
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        _themeMode.value = mode
        prefs?.edit()?.putString(KEY_THEME, mode.name)?.apply()
    }

    fun setHideLegacyTiles(hide: Boolean) {
        _hideLegacyTiles.value = hide
        prefs?.edit()?.putBoolean(KEY_HIDE_LEGACY, hide)?.apply()
    }

    /** Unknown/legacy strings fall back to SYSTEM rather than throwing. */
    fun parseThemeMode(raw: String?): ThemeMode =
        ThemeMode.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) } ?: ThemeMode.SYSTEM

    /** Pure resolution: the override wins, SYSTEM defers to the OS. */
    fun resolveDark(mode: ThemeMode, systemDark: Boolean): Boolean = when (mode) {
        ThemeMode.SYSTEM -> systemDark
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }
}
