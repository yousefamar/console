package io.amar.console.data.spaces

import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.core.HubConfig
import io.amar.console.sync.SyncBusClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Effort + placement pins (SPA d644f315, ^odd-newt): the board view carries
 * `effort` / `remote` per card and the board's own `remote:` default; the
 * mutations hit `POST /board/:project/effort` and the verb-addressed
 * `/forge` | `/local` (clearing = `/local` with `remote: null`).
 */
@RunWith(RobolectricTestRunner::class)
class SpacesPlacementTest {

    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope
    private val posts = java.util.concurrent.LinkedBlockingQueue<RecordedRequest>()
    private var boardJson = ""

    @Before
    fun setUp() {
        server = MockWebServer()
        // Served by PATH (never FIFO): HubConfig is process-wide, so background
        // pollers hit this server too.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "POST" && path.startsWith("/hub/board/console/") -> { posts.add(request); MockResponse().setBody("{}") }
                    request.method == "GET" && path == "/hub/board/console" -> MockResponse().setBody(boardJson)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        HubConfig.init(ApplicationProvider.getApplicationContext())
        HubConfig.setHubBase(server.url("/hub").toString())
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    @After
    fun tearDown() {
        scope.cancel()
        HubConfig.setHubBase("")
        runCatching { server.shutdown() }
    }

    private fun repo() = SpacesRepository(HubClient(), SyncBusClient(scope, initialBackoffMs = 0L))

    private fun card(text: String, extra: String) =
        """{"text":"$text","column":"Now","agentKey":null,"blockId":"abc","blocked":false,"checked":false,"nofork":false,"inherit":false,"model":null,$extra"detail":[]}"""

    @Test
    fun `board view parses effort, card placement and the board default`() = runBlocking {
        boardJson = """{"path":"projects/console/board.md","defaultOwner":null,"remote":"forge","columns":[{"title":"Now","cards":[
            ${card("Pinned", """"effort":"xhigh","remote":"local",""")},
            ${card("Plain", """"effort":null,"remote":null,""")},
            ${card("Old hub", "")},
            ${card("Junk", """"remote":"mars",""")}
        ]}]}"""
        val b = repo().fetchBoard("console")
        assertEquals("forge", b.remote)
        val cards = b.columns[0].cards
        assertEquals("xhigh", cards[0].effort); assertEquals("local", cards[0].remote)
        assertNull(cards[1].effort); assertNull(cards[1].remote)
        assertNull(cards[2].remote)
        assertNull(cards[3].remote)

        // A hub that predates the board-level field reads as unset.
        boardJson = """{"path":"p","defaultOwner":null,"columns":[]}"""
        assertNull(repo().fetchBoard("console").remote)
    }

    @Test
    fun `effort and placement mutations use the hub's verbs and null-clears`() = runBlocking {
        boardJson = """{"path":"p","defaultOwner":null,"columns":[]}"""
        val r = repo()
        val c = SpacesRepository.CardView("Pinned", "Now", null, "abc", blocked = false, checked = false, detail = emptyList())
        fun next(): Pair<String, String> = posts.poll(5, java.util.concurrent.TimeUnit.SECONDS)!!.let { it.path!! to it.body.readUtf8() }

        assertTrue(r.setEffort("console", c, "max"))
        assertEquals("/hub/board/console/effort" to """{"card":"^abc","effort":"max"}""", next())
        assertTrue(r.setEffort("console", c, null))
        assertEquals("/hub/board/console/effort" to """{"card":"^abc","effort":null}""", next())

        assertTrue(r.setRemote("console", c, "forge"))
        assertEquals("/hub/board/console/forge" to """{"card":"^abc"}""", next())
        assertTrue(r.setRemote("console", c, "local"))
        assertEquals("/hub/board/console/local" to """{"card":"^abc"}""", next())
        assertTrue(r.setRemote("console", c, null))
        assertEquals("/hub/board/console/local" to """{"card":"^abc","remote":null}""", next())
    }
}
