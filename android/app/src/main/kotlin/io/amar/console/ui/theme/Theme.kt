package io.amar.console.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

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

@Composable
fun ConsoleTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ConsoleDark,
        content = content,
    )
}
