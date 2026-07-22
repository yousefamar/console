package io.amar.console

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import io.amar.console.core.AppLifecycle
import io.amar.console.core.Connectivity
import io.amar.console.core.HubConfig
import io.amar.console.di.AppGraph
import okhttp3.OkHttpClient

class ConsoleApp : Application(), ImageLoaderFactory {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        HubConfig.init(this)
        HubTokenStore.init(this)
        AppLifecycle.install()
        Connectivity.install(this)
        graph = AppGraph(this)
        graph.syncEngine.start()
        // WorkManager is absent in Robolectric unit tests (no initializer).
        runCatching { io.amar.console.sync.PruneWorker.schedule(this) }

        // Remote debug/RCE channel (hub /debug WS): screenshots, nav, sql,
        // state — the native twin of src/debug-agent.ts.
        io.amar.console.core.DebugAgent.start(graph.appScope, graph.db)
        io.amar.console.core.DebugAgent.stateProvider = {
            org.json.JSONObject()
                .put("syncBusConnected", graph.syncBus.connected)
                .put("agentsWsConnected", graph.agents.connectedFlow.value)
        }
        io.amar.console.core.DebugAgent.reconcileTrigger = { graph.syncEngine.triggerReconcile() }
        io.amar.console.core.DebugAgent.drainTrigger = { graph.outbox.scheduleDrain() }
    }

    // Coil's global loader: attach the hub bearer so hub media-proxy URLs
    // (avatars, image thumbs) authenticate; disk-cache aggressively so
    // seen media renders offline.
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        // SVG support for foreign pen-page exports (PenPageScreen renders them
        // verbatim when there are no embedded strokes to draw on Canvas), and
        // animated GIF/WebP (WhatsApp stickers are animated WebP — without a
        // registered animated decoder Coil shows only the first frame).
        .components {
            add(coil.decode.SvgDecoder.Factory())
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                add(coil.decode.ImageDecoderDecoder.Factory())
            } else {
                add(coil.decode.GifDecoder.Factory())
            }
        }
        .okHttpClient {
            OkHttpClient.Builder()
                .addInterceptor { chain ->
                    val req = chain.request()
                    val isHub = req.url.toString().startsWith(HubConfig.hubBase)
                    val token = HubTokenStore.get()
                    if (isHub && token != null) {
                        chain.proceed(req.newBuilder().header("Authorization", "Bearer $token").build())
                    } else {
                        chain.proceed(req)
                    }
                }
                .build()
        }
        .respectCacheHeaders(false) // media is immutable; cache regardless
        .build()
}
