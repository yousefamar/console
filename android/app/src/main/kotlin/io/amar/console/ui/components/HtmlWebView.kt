package io.amar.console.ui.components

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * A JS-off WebView that sizes itself to its document height — REQUIRED inside
 * any `verticalScroll`/LazyColumn parent: Compose measures such children with
 * an UNSPECIFIED max-height, a WebView measures 0 there, and the content
 * silently never renders (the "blank email/article body" class of bug).
 *
 * `WebView.contentHeight` is computed by the renderer with JavaScript
 * disabled, in CSS px (== dp), so it maps directly to a Compose height.
 * Late-loading images grow the document after progress hits 100% — hence the
 * delayed re-polls.
 *
 * All link taps go to [onOpenUrl] (default: nothing renders navigations
 * in-place; callers pass an external-browser opener).
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun SelfSizingWebView(
    html: String,
    modifier: Modifier = Modifier,
    onOpenUrl: (String) -> Unit = {},
    configure: (WebView) -> Unit = {},
) {
    var contentHeightDp by remember { mutableStateOf(120) }
    AndroidView(
        modifier = modifier.fillMaxWidth().height(contentHeightDp.dp),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                val syncHeight = Runnable {
                    val h = contentHeight
                    if (h > 0) contentHeightDp = (h + 16).coerceIn(40, 20000)
                }
                webChromeClient = object : android.webkit.WebChromeClient() {
                    override fun onProgressChanged(view: WebView, newProgress: Int) {
                        if (newProgress == 100) {
                            view.post(syncHeight)
                            view.postDelayed(syncHeight, 400)
                            view.postDelayed(syncHeight, 1500)
                        }
                    }
                }
                webViewClient = object : android.webkit.WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: android.webkit.WebResourceRequest,
                    ): Boolean {
                        onOpenUrl(request.url.toString())
                        return true
                    }
                }
                configure(this)
            }
        },
        update = { wv -> wv.loadDataWithBaseURL(null, html, "text/html", "utf-8", null) },
    )
}
