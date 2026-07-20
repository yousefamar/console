package io.amar.console

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import io.amar.console.core.Updater
import io.amar.console.glasses.GlassesService
import io.amar.console.ui.nav.Pane
import io.amar.console.ui.shell.AppShell
import io.amar.console.ui.shell.openApp
import io.amar.console.ui.theme.ConsoleTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Console — native Compose host. Replaces the WebView wrapper (v38 and
 * earlier). Owns: navigation (incl. `console://pane/...` deep links from
 * notifications), runtime permissions, service startup, update banner.
 */
class MainActivity : ComponentActivity() {

    private lateinit var notificationPermissionLauncher: ActivityResultLauncher<String>
    private lateinit var blePermissionsLauncher: ActivityResultLauncher<Array<String>>
    private var navController: NavHostController? = null
    private var pendingDeepLink: Uri? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)

        notificationPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { /* no-op */ }

        blePermissionsLauncher = registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { results ->
            if (results[Manifest.permission.BLUETOOTH_CONNECT] == true) {
                GlassesService.start(this)
            }
        }

        setContent {
            ConsoleTheme {
                val nav = rememberNavController()
                navController = nav
                // A deep link may have arrived before composition.
                pendingDeepLink?.let { uri ->
                    pendingDeepLink = null
                    navigateDeepLink(nav, uri)
                }
                AppShell(application as ConsoleApp, nav)
            }
        }

        maybeRequestNotificationPermission()
        maybeRequestBlePermissions()
        CoroutineScope(Dispatchers.IO).launch { Updater.check() }

        // Glasses mirror owns the stealth-dim window state; re-assert the
        // persisted toggle on boot.
        (application as ConsoleApp).graph.mirror.applyDim = { enabled -> applyMirrorDim(enabled) }
        (application as ConsoleApp).graph.mirror.onBoot()

        io.amar.console.core.DebugAgent.onActivity(this)

        PushService.start(this)
        GlassesService.start(this)
        io.amar.console.pen.PenService.start(this)

        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND) {
            handleShare(intent)
            return
        }
        val data = intent?.data ?: return
        if (data.scheme != "console") return
        val nav = navController
        if (nav == null) {
            pendingDeepLink = data
            return
        }
        navigateDeepLink(nav, data)
    }

    /**
     * Share-target: text/URL shared from another app becomes a new scratch
     * note, opened in the editor. (AndroidManifest ACTION_SEND text/plain.)
     */
    private fun handleShare(intent: Intent) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        if (text.isNullOrEmpty()) return
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim()
        val app = application as ConsoleApp
        CoroutineScope(Dispatchers.IO).launch {
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.UK)
                .format(java.util.Date())
            val path = "scratch/shared-$stamp.md"
            val body = buildString {
                if (!subject.isNullOrEmpty()) append("# ").append(subject).append("\n\n")
                append(text)
                append('\n')
            }
            runCatching { app.graph.notes.create(path, body) }
            val nav = navController
            runOnUiThread {
                if (nav != null) {
                    nav.openApp(Pane.Notes)
                    runCatching { nav.navigate("notes/${Uri.encode(path)}") { launchSingleTop = true } }
                } else {
                    pendingDeepLink = Uri.parse("console://pane/notes")
                }
            }
        }
    }

    /**
     * `console://pane/<pane>?roomId=<id>` — same URIs PushService has always
     * used for notification taps; now routed natively instead of into a DOM
     * CustomEvent. Item-detail routes are registered per milestone; until a
     * pane has them we land on the pane root.
     */
    private fun navigateDeepLink(nav: NavHostController, data: Uri) {
        when (data.host) {
            "pane" -> {
                val paneName = data.path?.trim('/') ?: return
                val pane = Pane.fromPushPane(paneName)
                val itemId = data.getQueryParameter("roomId") ?: data.getQueryParameter("itemId")
                val detail = when {
                    !itemId.isNullOrEmpty() && pane == Pane.Chat -> "chat/${Uri.encode(itemId)}"
                    !itemId.isNullOrEmpty() && pane == Pane.Mail -> "mail/${Uri.encode(itemId)}"
                    !itemId.isNullOrEmpty() && pane == Pane.Agents -> "agents/${Uri.encode(itemId)}"
                    !itemId.isNullOrEmpty() && pane == Pane.Feeds -> "feeds/${Uri.encode(itemId)}"
                    !itemId.isNullOrEmpty() && pane == Pane.Notes -> "notes/${Uri.encode(itemId)}"
                    else -> null
                }
                // Hierarchy contract: build the REAL stack (grid → root →
                // detail) so back from a notification-opened detail walks
                // root → grid, never exits the app sideways.
                nav.openApp(pane)
                if (detail != null) {
                    runCatching { nav.navigate(detail) { launchSingleTop = true } }
                }
            }
            "pair" -> {
                // console://pair?hub=<url>&token=<bearer> — QR from the SPA.
                val hubUrl = data.getQueryParameter("hub")
                val token = data.getQueryParameter("token")
                if (!hubUrl.isNullOrBlank()) io.amar.console.core.HubConfig.setHubBase(hubUrl)
                if (!token.isNullOrBlank()) {
                    HubTokenStore.set(token)
                    PushService.kick(this)
                }
                nav.openApp(Pane.Settings)
            }
        }
    }

    /** "Stealth screen" for the glasses mirror: panel looks off, Activity
     *  stays foreground so input + mirror keep flowing. Ported from v38. */
    fun applyMirrorDim(enabled: Boolean) {
        runOnUiThread {
            val lp = window.attributes
            if (enabled) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                lp.screenBrightness = 0.01f
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
            window.attributes = lp
        }
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun maybeRequestBlePermissions(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val perms = arrayOf(
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN,
        )
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) return true
        blePermissionsLauncher.launch(missing.toTypedArray())
        return false
    }
}
