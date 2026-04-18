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
 * Loads the tailnet URL directly, intercepts OAuth into Chrome Custom Tabs,
 * and handles `console://` deep links for OAuth return / navigation.
 */
class MainActivity : ComponentActivity() {

    private val appUrl = "https://amarhp-lin.rya-yo.ts.net:5173/"

    private lateinit var webView: WebView
    private lateinit var errorView: LinearLayout
    private lateinit var rootLayout: FrameLayout
    private var pageLoaded = false

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Array<String>>
    private var updateBanner: View? = null

    private lateinit var notificationPermissionLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !pageLoaded }

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
        checkForUpdateAsync()
        PushService.start(this)
    }

    // --- JS bridge ------------------------------------------------------------

    private inner class ConsoleBridge {
        /** Web → native: re-run the APK update check (e.g. from the refresh button). */
        @JavascriptInterface
        fun checkForUpdate() {
            checkForUpdateAsync()
        }
    }

    // --- Update check ---------------------------------------------------------

    private fun checkForUpdateAsync() {
        Thread {
            try {
                val url = URL(appUrl.trimEnd('/').replace(":5173", ":9877") + "/apk/latest.json")
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
        val fullUrl = if (apkUrl.startsWith("http")) apkUrl else
            appUrl.trimEnd('/').replace(":5173", ":9877") + apkUrl
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
            text = "Make sure Tailscale is running on this phone."
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
