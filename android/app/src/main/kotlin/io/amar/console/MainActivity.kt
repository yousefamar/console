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
                val route = if (!itemId.isNullOrEmpty() && pane == Pane.Chat) {
                    "chat/${Uri.encode(itemId)}"
                } else {
                    pane.route
                }
                try {
                    nav.navigate(route) { launchSingleTop = true }
                } catch (_: IllegalArgumentException) {
                    // Detail route not registered yet (pre-milestone) — pane root.
                    nav.navigate(pane.route) { launchSingleTop = true }
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
                nav.navigate("settings") { launchSingleTop = true }
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
