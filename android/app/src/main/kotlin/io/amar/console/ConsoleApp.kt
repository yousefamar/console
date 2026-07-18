package io.amar.console

import android.app.Application
import io.amar.console.core.AppLifecycle
import io.amar.console.core.Connectivity
import io.amar.console.core.HubConfig
import io.amar.console.di.AppGraph

class ConsoleApp : Application() {
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
    }
}
