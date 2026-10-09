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
    private const val KEY_CHANGELOG = "changelog"
    private const val KEY_LAST_SEEN_VERSION = "lastSeenVersion"

    enum class ThemeMode { SYSTEM, DARK, LIGHT }

    @Volatile private var prefs: SharedPreferences? = null

    private val _themeMode = MutableStateFlow(ThemeMode.SYSTEM)
    val themeMode: StateFlow<ThemeMode> = _themeMode

    private val _hideLegacyTiles = MutableStateFlow(false)
    val hideLegacyTiles: StateFlow<Boolean> = _hideLegacyTiles

    /** Release notes from the last latest.json fetch. Persisted so "What's new"
     *  works offline and on the first launch after an update. */
    private val _changelog = MutableStateFlow<List<ChangelogVersion>>(emptyList())
    val changelog: StateFlow<List<ChangelogVersion>> = _changelog

    /** The app version whose notes were last shown; 0 = never. */
    private val _lastSeenVersion = MutableStateFlow(0)
    val lastSeenVersion: StateFlow<Int> = _lastSeenVersion

    /** Idempotent; safe from any process entry point. */
    fun init(context: Context) {
        if (prefs != null) return
        synchronized(this) {
            if (prefs != null) return
            val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            prefs = p
            _themeMode.value = parseThemeMode(p.getString(KEY_THEME, null))
            _hideLegacyTiles.value = p.getBoolean(KEY_HIDE_LEGACY, false)
            _changelog.value = Changelog.parse(p.getString(KEY_CHANGELOG, null))
            _lastSeenVersion.value = p.getInt(KEY_LAST_SEEN_VERSION, 0)
        }
    }

    /** An empty list is a failed or notes-less fetch, never a reason to drop the cache. */
    fun setChangelog(versions: List<ChangelogVersion>) {
        if (versions.isEmpty()) return
        _changelog.value = versions
        prefs?.edit()?.putString(KEY_CHANGELOG, Changelog.encode(versions))?.apply()
    }

    fun setLastSeenVersion(versionCode: Int) {
        _lastSeenVersion.value = versionCode
        prefs?.edit()?.putInt(KEY_LAST_SEEN_VERSION, versionCode)?.apply()
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
