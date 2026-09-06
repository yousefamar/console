package io.amar.console.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import io.amar.console.core.AppPrefs

// Console's terse dark palette — matches the SPA (#0a0a0a / #141414 / #e5e5e5).
private val ConsoleDark = darkColorScheme(
    primary = Color(0xFF60A5FA),          // blue-400 accents
    onPrimary = Color(0xFF0A0A0A),
    secondary = Color(0xFF9CA3AF),
    background = Color(0xFF0A0A0A),
    onBackground = Color(0xFFE5E5E5),
    surface = Color(0xFF141414),
    onSurface = Color(0xFFE5E5E5),
    surfaceVariant = Color(0xFF1F1F1F),
    onSurfaceVariant = Color(0xFF9CA3AF),
    error = Color(0xFFF87171),
    outline = Color(0xFF2A2A2A),
)

// The SPA's `:root` light tokens (src/index.css): surface-0..3 white→#e5e5e5,
// text #171717/#525252/#a3a3a3, accent #2563eb. Container roles are pinned
// neutral too — M3's defaults are purple-tinted and would leak into chips,
// segmented buttons, sheets and dialogs.
private val ConsoleLight = lightColorScheme(
    primary = Color(0xFF2563EB),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFDBEAFE),
    onPrimaryContainer = Color(0xFF1E3A8A),
    inversePrimary = Color(0xFF60A5FA),
    secondary = Color(0xFF525252),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE5E5E5),
    onSecondaryContainer = Color(0xFF171717),
    tertiary = Color(0xFF7C3AED),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFEDE9FE),
    onTertiaryContainer = Color(0xFF4C1D95),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF171717),
    surface = Color(0xFFF7F7F7),
    onSurface = Color(0xFF171717),
    surfaceVariant = Color(0xFFEFEFEF),
    onSurfaceVariant = Color(0xFF525252),
    surfaceTint = Color(0xFF2563EB),
    inverseSurface = Color(0xFF171717),
    inverseOnSurface = Color(0xFFF7F7F7),
    error = Color(0xFFDC2626),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
    outline = Color(0xFFC7C7C7),
    outlineVariant = Color(0xFFE0E0E0),
    scrim = Color(0xFF000000),
    surfaceBright = Color(0xFFFFFFFF),
    surfaceDim = Color(0xFFE5E5E5),
    surfaceContainer = Color(0xFFEFEFEF),
    surfaceContainerHigh = Color(0xFFE5E5E5),
    surfaceContainerHighest = Color(0xFFE0E0E0),
    surfaceContainerLow = Color(0xFFF7F7F7),
    surfaceContainerLowest = Color(0xFFFFFFFF),
)

/**
 * Semantic status colours beside the M3 scheme. Dark = Tailwind 400s (what
 * the app always used); light = the SPA's `:root` success/warning/destructive
 * tokens — the 400s sit at ~2:1 contrast on white, unreadable as text.
 */
@Immutable
data class ConsoleAccents(
    val green: Color,
    val red: Color,
    val amber: Color,
    val violet: Color,
    val blue: Color,
)

private val DarkAccents = ConsoleAccents(
    green = Color(0xFF4ADE80), red = Color(0xFFF87171), amber = Color(0xFFF59E0B),
    violet = Color(0xFFA78BFA), blue = Color(0xFF60A5FA),
)
private val LightAccents = ConsoleAccents(
    green = Color(0xFF16A34A), red = Color(0xFFDC2626), amber = Color(0xFFD97706),
    violet = Color(0xFF7C3AED), blue = Color(0xFF2563EB),
)

private val LocalConsoleAccents = staticCompositionLocalOf { DarkAccents }
private val LocalConsoleDark = staticCompositionLocalOf { true }

val MaterialTheme.accents: ConsoleAccents
    @Composable @ReadOnlyComposable get() = LocalConsoleAccents.current

/** True while the dark scheme is active (WebView CSS, map-style pickers, mail defaults). */
val MaterialTheme.isDark: Boolean
    @Composable @ReadOnlyComposable get() = LocalConsoleDark.current

/** `#rrggbb` for CSS injected into WebViews. */
fun Color.toCssHex(): String = String.format("#%06x", toArgb() and 0xFFFFFF)

@Composable
fun ConsoleTheme(content: @Composable () -> Unit) {
    val mode by AppPrefs.themeMode.collectAsState()
    val dark = AppPrefs.resolveDark(mode, isSystemInDarkTheme())
    val scheme: ColorScheme = if (dark) ConsoleDark else ConsoleLight

    // themes.xml paints dark system bars + white icons; a light scheme needs
    // both flipped at runtime (the XML can't see the in-app override).
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            val bar = scheme.background.toArgb()
            @Suppress("DEPRECATION")
            run {
                window.statusBarColor = bar
                window.navigationBarColor = bar
            }
            window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(bar))
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    CompositionLocalProvider(
        LocalConsoleAccents provides (if (dark) DarkAccents else LightAccents),
        LocalConsoleDark provides dark,
    ) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
