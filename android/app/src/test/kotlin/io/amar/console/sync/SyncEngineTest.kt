package io.amar.console.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.atomic.AtomicInteger

/**
 * backgroundSync (^brisk-moth): borrow the WS for one pass, tear it down,
 * throttle repeat borrows, and leave the socket alone while foreground.
 */
@RunWith(RobolectricTestRunner::class)
class SyncEngineTest {

    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope
    private lateinit var db: ConsoleDb
    private lateinit var syncBus: SyncBusClient
    private lateinit var engine: SyncEngine
    private val context: Context = ApplicationProvider.getApplicationContext()
    /** Injected foreground state — never flip the process-wide AppLifecycle
     *  in tests (the real ConsoleApp graph reacts to it). */
    private var foreground = false

    /** WS upgrade requests served — the "did anything borrow a socket" probe
     *  (plain HTTP like the HubPrefs refresh inside a pass gets a 404 and
     *  doesn't count). */
    private val upgrades = AtomicInteger(0)

    @Before
    fun setUp() {
        io.amar.console.core.HubConfig.init(context)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (request.headers["Upgrade"] == "websocket") {
                    upgrades.incrementAndGet()
                    MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {}
                    })
                } else MockResponse().setResponseCode(404)
            }
        }
        server.start()
        io.amar.console.core.HubConfig.setHubBase(server.url("/hub").toString())
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        db = Room.inMemoryDatabaseBuilder(context, ConsoleDb::class.java)
            .allowMainThreadQueries().build()
        val hub = HubClient()
        syncBus = SyncBusClient(scope, initialBackoffMs = 0L)
        val outbox = Outbox(context, scope, db, hub, syncBus, durableScheduler = {})
        engine = SyncEngine(
            scope, db, hub, syncBus, outbox,
            bgConnectTimeoutMs = 3_000,
            isForeground = { foreground },
        )
    }

    @After
    fun tearDown() {
        syncBus.stop()
        scope.cancel()
        runCatching { server.shutdown() }
        db.close()
    }

    @Test
    fun `background borrow runs one pass and tears the socket down`() = runBlocking {
        val runs = AtomicInteger(0)
        engine.addDomain("probe") { runs.incrementAndGet() }
        engine.backgroundSync()
        assertEquals(1, runs.get())
        assertFalse("socket must be torn down after the borrow", syncBus.connected)
    }

    @Test
    fun `second borrow inside the throttle window no-ops, force bypasses`() = runBlocking {
        val runs = AtomicInteger(0)
        engine.addDomain("probe") { runs.incrementAndGet() }
        engine.backgroundSync()
        engine.backgroundSync() // throttled
        assertEquals(1, runs.get())
        engine.backgroundSync(force = true)
        assertEquals(2, runs.get())
        assertFalse(syncBus.connected)
    }

    @Test
    fun `hub unreachable borrow gives up without leaving a reconnect loop`() = runBlocking {
        runCatching { server.shutdown() } // kill the hub before the borrow
        val runs = AtomicInteger(0)
        engine.addDomain("probe") { runs.incrementAndGet() }
        engine.backgroundSync()
        // No connect → the domain pass is skipped, and the borrow's stop()
        // must have killed the background reconnect loop it started.
        assertEquals(0, runs.get())
        assertFalse(syncBus.connected)
    }

    @Test
    fun `foreground call feeds the normal reconciler and never borrows`() = runBlocking {
        foreground = true
        val runs = AtomicInteger(0)
        engine.addDomain("probe") { runs.incrementAndGet() }
        engine.backgroundSync()
        // Debounced trigger path — wait for the pass to land.
        val deadline = System.currentTimeMillis() + 5_000
        while (runs.get() == 0 && System.currentTimeMillis() < deadline) {
            kotlinx.coroutines.delay(25)
        }
        assertEquals(1, runs.get())
        assertEquals("foreground path must not open a borrowed socket", 0, upgrades.get())
    }
}
