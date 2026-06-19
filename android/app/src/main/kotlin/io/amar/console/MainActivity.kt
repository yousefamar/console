package io.amar.console

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.util.Base64
import io.amar.console.glasses.BleManager
import io.amar.console.glasses.G1Protocol
import io.amar.console.glasses.GlassesController
import io.amar.console.glasses.GlassesService
import io.amar.console.glasses.GlassesState
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Console — single WebView activity.
 *
 * Loads https://con.amar.io/ directly (public Caddy + Let's Encrypt cert,
 * no Tailscale required), intercepts OAuth into Chrome Custom Tabs, handles
 * `console://` deep links.
 */
class MainActivity : ComponentActivity() {

    companion object {
        // True while the Console WebView is foreground (and thus the SPA's
        // sync-bus is live). PushService reads this to decide where a PTT
        // transcript goes: composer if foreground, else auto-send.
        @Volatile var foreground: Boolean = false
    }

    // Public URL on the home Caddy. Resolves via Namecheap DDNS, served by
    // Caddy on :443 with a real Let's Encrypt cert. SPA + hub + /public/*
    // all live on the same origin (see /etc/caddy/Caddyfile con.amar.io block).
    private val appUrl = "https://con.amar.io/"

    // Same-origin: APK in-app updater hits ${publicBaseUrl}/public/apk/...
    private val publicBaseUrl: String by lazy { appUrl.trimEnd('/') }

    private lateinit var webView: WebView
    private lateinit var errorView: LinearLayout
    private lateinit var rootLayout: FrameLayout
    private var pageLoaded = false

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Array<String>>
    private var updateBanner: View? = null

    private lateinit var notificationPermissionLauncher: ActivityResultLauncher<String>
    private lateinit var blePermissionsLauncher: ActivityResultLauncher<Array<String>>
    private lateinit var micPermissionLauncher: ActivityResultLauncher<String>
    // WebView mic request awaiting the OS RECORD_AUDIO grant (answered in the
    // launcher callback once the user responds to the system dialog).
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    private val glassesStateListener: () -> Unit = { emitGlassesState() }
    private val glassesBleListener = object : BleManager.Listener {
        override fun onTouch(arm: G1Protocol.Arm, subcmd: Byte) {
            emitGlassesEvent("touch", JSONObject().apply {
                put("arm", arm.name.lowercase())
                put("subcmd", subcmd.toInt() and 0xFF)
            })
        }
        override fun onAudioFrame(seq: Int, lc3Bytes: ByteArray) {
            // Frame-rate is ~50 fps; we push a base64 blob per frame. Listeners
            // filter by event name. This is v1 scaffolding — consumers outside
            // the SPA should use the hub WS `mic.frame` event, not DOM events.
            emitGlassesEvent("audio", JSONObject().apply {
                put("seq", seq)
                put("lc3b64", Base64.encodeToString(lc3Bytes, Base64.NO_WRAP))
            })
        }
        override fun onStateChange() { emitGlassesState() }
        override fun onError(msg: String) {
            emitGlassesEvent("error", JSONObject().put("message", msg))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !pageLoaded }

        // Initialize EncryptedSharedPreferences before anything else can read
        // the token (PushService starts a few lines down; pairing flow may
        // call into HubTokenStore via the JS bridge).
        HubTokenStore.init(this)

        WindowInsetsControllerCompat(window, window.decorView)
            .isAppearanceLightStatusBars = false

        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.OpenMultipleDocuments()
        ) { uris ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(uris.toTypedArray())
        }

        notificationPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { /* no-op */ }

        micPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { granted ->
            val req = pendingWebPermissionRequest
            pendingWebPermissionRequest = null
            req ?: return@registerForActivityResult
            runOnUiThread { if (granted) req.grant(req.resources) else req.deny() }
        }

        blePermissionsLauncher = registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { results ->
            val connect = results[Manifest.permission.BLUETOOTH_CONNECT] == true
            // Kick the service now that perms exist; it'll auto-reconnect
            // to the stored pair (if any) and be ready for scan requests.
            if (connect) GlassesService.start(this)
        }

        rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(Color.parseColor("#0a0a0a"))
        }
        setContentView(rootLayout)

        // Android 15 (targetSdk 35) is edge-to-edge by default: the window
        // extends under status/nav bars. Pad the root so the WebView's content
        // stays visible. IME insets are left alone so `adjustResize` still
        // shrinks the layout above the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        buildErrorView()
        buildWebView()
        rootLayout.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        webView.loadUrl(appUrl)
        handleDeepLink(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        maybeRequestNotificationPermission()
        maybeRequestBlePermissions()
        checkForUpdateAsync()
        PushService.start(this)
        GlassesService.start(this)

        GlassesState.addListener(glassesStateListener)
        attachGlassesBleListener()
    }

    /** The GlassesService onCreate() runs async from startForegroundService(), so
     *  poll briefly for BleManager to become available, then subscribe. */
    private fun attachGlassesBleListener(attempt: Int = 0) {
        if (GlassesController.isReady()) {
            try { GlassesController.requireBle().addListener(glassesBleListener) } catch (_: Throwable) {}
            return
        }
        if (attempt >= 50) return // 5s total; BLE sim isn't available, give up.
        Handler(Looper.getMainLooper()).postDelayed({ attachGlassesBleListener(attempt + 1) }, 100L)
    }

    override fun onResume() {
        super.onResume()
        foreground = true
    }

    override fun onPause() {
        foreground = false
        super.onPause()
    }

    override fun onDestroy() {
        foreground = false
        GlassesState.removeListener(glassesStateListener)
        if (GlassesController.isReady()) {
            try { GlassesController.requireBle().removeListener(glassesBleListener) } catch (_: Throwable) {}
        }
        super.onDestroy()
    }

    // --- JS bridge ------------------------------------------------------------

    private inner class ConsoleBridge {
        /** Web → native: re-run the APK update check (e.g. from the refresh button). */
        @JavascriptInterface
        fun checkForUpdate() {
            checkForUpdateAsync()
        }

        // --- Hub bearer token (paired by the authenticated SPA) ------------

        /**
         * Set the long-lived hub bearer for PushService. Called by the SPA's
         * "Pair this APK" action after it has minted a new token via
         * POST /hub/auth/tokens. Reconnects PushService so the new token
         * takes effect immediately.
         */
        @JavascriptInterface
        fun setHubToken(token: String) {
            if (token.isBlank()) return
            HubTokenStore.set(token)
            PushService.kick(this@MainActivity)
        }

        /** True if the APK has a stored bearer (does NOT validate it). */
        @JavascriptInterface
        fun hasHubToken(): Boolean = HubTokenStore.get() != null

        /** Drop the stored bearer (used when revoking from another device). */
        @JavascriptInterface
        fun clearHubToken() {
            HubTokenStore.clear()
            PushService.kick(this@MainActivity)
        }

        // --- Glasses: status ------------------------------------------------

        /** Returns the current glasses state as a JSON string. */
        @JavascriptInterface
        fun glassesStatus(): String = GlassesState.toJson().toString()

        /** Returns current scan candidates as a JSON array string. */
        @JavascriptInterface
        fun glassesScanCandidates(): String = GlassesState.scanCandidatesJson().toString()

        // --- Glasses: pairing ----------------------------------------------

        @JavascriptInterface
        fun glassesScan(durationMs: Long) {
            if (!maybeRequestBlePermissions()) return
            if (!GlassesController.isReady()) return
            GlassesController.scan(if (durationMs <= 0) 15_000L else durationMs)
        }

        @JavascriptInterface
        fun glassesStopScan() {
            if (GlassesController.isReady()) GlassesController.stopScan()
        }

        @JavascriptInterface
        fun glassesPair(leftMac: String, rightMac: String, channel: String) {
            if (!maybeRequestBlePermissions()) return
            if (!GlassesController.isReady()) return
            GlassesController.pair(leftMac, rightMac, channel)
        }

        @JavascriptInterface
        fun glassesUnpair() {
            if (GlassesController.isReady()) GlassesController.unpair()
        }

        @JavascriptInterface
        fun glassesDisconnect() {
            if (GlassesController.isReady()) GlassesController.requireBle().disconnect()
        }

        // --- Glasses: display commands -------------------------------------

        @JavascriptInterface
        fun glassesSendText(text: String) {
            if (GlassesController.isReady()) GlassesController.sendText(text)
        }

        @JavascriptInterface
        fun glassesClear() {
            if (GlassesController.isReady()) GlassesController.sendExit()
        }

        /** `bmpB64` is a standard base64-encoded 1-bit BMP (576×136). */
        @JavascriptInterface
        fun glassesSendBmp(bmpB64: String) {
            if (!GlassesController.isReady()) return
            try {
                val bmp = Base64.decode(bmpB64, Base64.DEFAULT)
                GlassesController.sendBmp(bmp)
            } catch (_: Throwable) {
                emitGlassesEvent("error", JSONObject().put("message", "bad bmp base64"))
            }
        }

        /** `json` must already be a JSON object shaped like `{ncs_notification:{...}}`. */
        @JavascriptInterface
        fun glassesNotify(json: String) {
            if (!GlassesController.isReady()) return
            val msgId = (System.currentTimeMillis() and 0xFF).toInt()
            GlassesController.sendNotification(msgId, json)
        }

        @JavascriptInterface
        fun glassesStartMic() {
            if (GlassesController.isReady()) GlassesController.setMic(true)
        }

        @JavascriptInterface
        fun glassesStopMic() {
            if (GlassesController.isReady()) GlassesController.setMic(false)
        }

        // --- Mirror "stealth screen" ---------------------------------------
        //
        // When the app-wide glasses mirror is on we want the screen to
        // *appear* off (so the user reads only the glasses) without the OS
        // pausing the Activity — otherwise HW-keyboard events stop flowing
        // to the WebView. The trick: hold FLAG_KEEP_SCREEN_ON and drive
        // screenBrightness to ~0. The panel is effectively black but the
        // Activity keeps foreground, keyboard input keeps working.

        @JavascriptInterface
        fun setMirrorDim(enabled: Boolean) {
            runOnUiThread { applyMirrorDim(enabled) }
        }

        /** @deprecated v17: renamed to setMirrorDim. Kept so older SPA
         *  bundles still work during the rolling upgrade. */
        @JavascriptInterface
        fun setNotesMirrorDim(enabled: Boolean) {
            runOnUiThread { applyMirrorDim(enabled) }
        }
    }

    /** Toggle "screen appears off but Activity alive" mode. UI thread only. */
    private fun applyMirrorDim(enabled: Boolean) {
        val lp = window.attributes
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            // 0.01f — lowest non-zero. Exactly 0 can be interpreted as
            // BRIGHTNESS_OVERRIDE_OFF on some OEM builds which kills the
            // Activity; 0.01 is visually black on modern panels.
            lp.screenBrightness = 0.01f
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
        window.attributes = lp
    }

    // --- Glasses bridge: event plumbing --------------------------------------

    private fun emitGlassesState() {
        runOnUiThread {
            val json = GlassesState.toJson().toString()
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('console:glasses:state', { detail: $json }));",
                null,
            )
        }
    }

    private fun emitGlassesEvent(name: String, detail: JSONObject) {
        runOnUiThread {
            val envelope = JSONObject().apply {
                put("name", name)
                put("detail", detail)
            }
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('console:glasses:event', { detail: $envelope }));",
                null,
            )
        }
    }

    /** Returns true if perms are already granted, false if we had to prompt. */
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

    // --- Update check ---------------------------------------------------------

    private fun checkForUpdateAsync() {
        Thread {
            try {
                val url = URL("$publicBaseUrl/public/apk/latest.json")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 5_000
                conn.readTimeout = 5_000
                if (conn.responseCode != 200) return@Thread
                val body = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
                val json = JSONObject(body)
                val remoteCode = json.optInt("versionCode", -1)
                val remoteUrl = json.optString("url", "")
                if (remoteCode > BuildConfig.VERSION_CODE && remoteUrl.isNotEmpty()) {
                    Handler(Looper.getMainLooper()).post { showUpdateBanner(remoteUrl, json.optString("versionName", "")) }
                }
            } catch (_: Exception) { /* offline / no release */ }
        }.start()
    }

    private fun showUpdateBanner(apkUrl: String, versionName: String) {
        // Don't stack if a banner is already showing (e.g. user taps refresh
        // repeatedly before dismissing the first one).
        if (updateBanner?.parent != null) return
        val banner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1f2937"))
            setPadding(24, 16, 24, 16)
        }
        val text = TextView(this).apply {
            text = if (versionName.isNotEmpty()) "Update available ($versionName)" else "Update available"
            setTextColor(Color.parseColor("#e5e5e5"))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val install = Button(this).apply {
            setText("Install")
            setOnClickListener {
                downloadAndInstall(apkUrl)
                (banner.parent as? ViewGroup)?.removeView(banner)
            }
        }
        val dismiss = Button(this).apply {
            setText("×")
            setOnClickListener { (banner.parent as? ViewGroup)?.removeView(banner) }
        }
        banner.addView(text)
        banner.addView(install)
        banner.addView(dismiss)
        updateBanner = banner
        rootLayout.addView(
            banner,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ),
        )
    }

    private fun downloadAndInstall(apkUrl: String) {
        // latest.json carries `url: /apk/console-N.apk` (the hub-side format
        // dating back to the pre-public era). Rewrite to /public/apk so the
        // download works once the hub binds 127.0.0.1 and only Caddy's
        // /public/* route reaches the apk handler.
        val publicPath = apkUrl.replace(Regex("^/apk/"), "/public/apk/")
        val fullUrl = if (publicPath.startsWith("http")) publicPath else "$publicBaseUrl$publicPath"
        try {
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(Uri.parse(fullUrl))
                .setTitle("Console update")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "console-update.apk")
            val id = dm.enqueue(req)
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    val finishedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                    if (finishedId == id) {
                        ctx.unregisterReceiver(this)
                        val uri = dm.getUriForDownloadedFile(id) ?: return
                        val install = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/vnd.android.package-archive")
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
                        }
                        try { ctx.startActivity(install) } catch (_: Exception) { /* no installer */ }
                    }
                }
            }
            val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(receiver, filter)
            }
        } catch (_: Exception) { /* silent */ }
    }

    private fun buildWebView() {
        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                setSupportMultipleWindows(true)
                javaScriptCanOpenWindowsAutomatically = true
                allowFileAccess = false
                allowContentAccess = false
                cacheMode = WebSettings.LOAD_DEFAULT
                loadWithOverviewMode = true
                useWideViewPort = true
                userAgentString = "$userAgentString ConsoleAPK/${BuildConfig.VERSION_NAME}"
                setGeolocationEnabled(true)
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            if (BuildConfig.DEBUG) {
                WebView.setWebContentsDebuggingEnabled(true)
            }

            // JS → native bridge. The web app can call
            //   window.ConsoleNative.checkForUpdate()
            // from the refresh button to re-run the APK update check without
            // waiting for the next cold start.
            addJavascriptInterface(ConsoleBridge(), "ConsoleNative")
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                return routeIfExternal(request.url, url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageLoaded = true
                view?.evaluateJavascript(
                    """
                    (function(){
                      window.__isConsoleAPK = true;
                      window.__consoleAPK = { version: '${BuildConfig.VERSION_NAME}', code: ${BuildConfig.VERSION_CODE} };
                      if (navigator.storage && navigator.storage.persist) {
                        navigator.storage.persist().catch(function(){});
                      }
                    })();
                    """.trimIndent(),
                    null,
                )
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame == true) {
                    showErrorView()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                // window.open() from the web app — route the target into Custom Tabs
                val popup = WebView(this@MainActivity)
                popup.settings.javaScriptEnabled = true
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        v: WebView,
                        req: WebResourceRequest,
                    ): Boolean {
                        launchCustomTab(req.url)
                        return true
                    }
                }
                val transport = resultMsg.obj as WebView.WebViewTransport
                transport.webView = popup
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                val types = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() }
                val mime = if (types.isNullOrEmpty()) arrayOf("*/*") else types.toTypedArray()
                return try {
                    fileChooserLauncher.launch(mime)
                    true
                } catch (e: Exception) {
                    this@MainActivity.filePathCallback = null
                    false
                }
            }

            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) {
                    android.util.Log.d(
                        "ConsoleWV",
                        "[${cm.messageLevel()}] ${cm.message()} (${cm.sourceId()}:${cm.lineNumber()})",
                    )
                }
                return true
            }

            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                // Mic capture additionally needs the app's OS RECORD_AUDIO grant —
                // granting the WebView request alone isn't enough. Request it the
                // first time, then answer the WebView request in the launcher cb.
                val wantsMic = request.resources.contains(
                    android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE
                )
                if (wantsMic && ContextCompat.checkSelfPermission(
                        this@MainActivity, Manifest.permission.RECORD_AUDIO
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    pendingWebPermissionRequest = request
                    runOnUiThread { micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO) }
                    return
                }
                runOnUiThread { request.grant(request.resources) }
            }
        }
    }

    private fun routeIfExternal(uri: Uri, url: String): Boolean {
        if (url.startsWith("https://accounts.google.com") ||
            url.contains("/auth/google/start") ||
            url.contains("/auth/google/callback")
        ) {
            launchCustomTab(uri)
            return true
        }
        if (uri.scheme == "console") {
            handleDeepLink(Intent(Intent.ACTION_VIEW, uri))
            return true
        }
        if (uri.scheme in setOf("mailto", "tel", "sms", "intent", "market", "geo")) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (_: Exception) { /* no handler */ }
            return true
        }
        return false
    }

    private fun launchCustomTab(uri: Uri) {
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(false)
            .build()
        try {
            intent.launchUrl(this, uri)
        } catch (_: Exception) {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "console") return

        val host = data.host ?: ""
        val path = data.path ?: ""

        when {
            host == "auth" && path.startsWith("/done") -> {
                // OAuth returned via Custom Tab. The Custom Tab now holds the
                // session cookie but the WebView (separate jar) does not. If
                // the hub deep-linked us with `?ott=…`, navigate the WebView
                // to /hub/auth/claim to redeem it into the WebView's jar.
                val ott = data.getQueryParameter("ott")
                if (!ott.isNullOrEmpty()) {
                    val claimUrl = "https://con.amar.io/hub/auth/claim?ott=" + Uri.encode(ott)
                    webView.loadUrl(claimUrl)
                } else {
                    // No OTT (shouldn't happen post-refactor); fall back to a
                    // reload so the SPA re-probes /auth/session.
                    webView.loadUrl(appUrl)
                }
                webView.evaluateJavascript(
                    """
                    (function(){
                      try {
                        window.dispatchEvent(new CustomEvent('console:auth-return', { detail: { source: 'apk' } }));
                      } catch(e) {}
                    })();
                    """.trimIndent(),
                    null,
                )
            }
            host == "pane" -> {
                val pane = path.trim('/')
                val roomId = data.getQueryParameter("roomId")
                // Build detail JSON: always include pane; include itemId if we
                // have a roomId so the web handler can navigate to the room.
                val detail = StringBuilder("{ pane: ")
                    .append(JSONObject.quote(pane))
                if (!roomId.isNullOrEmpty()) {
                    detail.append(", itemId: ").append(JSONObject.quote(roomId))
                }
                detail.append(" }")
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('console:navigate', { detail: $detail }));",
                    null,
                )
            }
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

    private fun buildErrorView() {
        errorView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0a0a0a"))
            visibility = View.GONE
            setPadding(48, 48, 48, 48)
        }
        val msg = TextView(this).apply {
            text = "Cannot reach Console"
            setTextColor(Color.parseColor("#e5e5e5"))
            textSize = 18f
            gravity = Gravity.CENTER
        }
        val hint = TextView(this).apply {
            text = "Couldn't reach con.amar.io. Check your internet connection."
            setTextColor(Color.parseColor("#9ca3af"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 32)
        }
        val retry = Button(this).apply {
            text = "Retry"
            setOnClickListener {
                errorView.visibility = View.GONE
                webView.visibility = View.VISIBLE
                webView.loadUrl(appUrl)
            }
        }
        errorView.addView(msg)
        errorView.addView(hint)
        errorView.addView(retry)
        rootLayout.addView(
            errorView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    private fun showErrorView() {
        runOnUiThread {
            pageLoaded = true
            webView.visibility = View.GONE
            errorView.visibility = View.VISIBLE
        }
    }
}
