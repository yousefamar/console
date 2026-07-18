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
    }

    // Coil's global loader: attach the hub bearer so hub media-proxy URLs
    // (avatars, image thumbs) authenticate; disk-cache aggressively so
    // seen media renders offline.
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
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
