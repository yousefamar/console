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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Card image attach goes through the hub's `POST /board/:project/attach`
 * (base64 body, `^id` address) — never a raw asset PUT + board-file edit —
 * and hands the asset path back so the sheet can show the thumbnail at once.
 */
@RunWith(RobolectricTestRunner::class)
class SpacesAttachTest {

    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope
    private val attachRequests = java.util.concurrent.LinkedBlockingQueue<RecordedRequest>()
    private var attachResponse: MockResponse = MockResponse().setResponseCode(503)
    private var moveResponse: MockResponse = MockResponse().setResponseCode(503)

    @Before
    fun setUp() {
        server = MockWebServer()
        // Serve by PATH — HubConfig is process-wide and stray pollers would eat
        // a FIFO-queued response (InboxRulesPersistenceTest precedent).
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/hub/board/console/attach" -> { attachRequests.add(request); attachResponse }
                "/hub/board/console/move" -> moveResponse
                "/hub/board/console" -> MockResponse().setBody("""{"path":"projects/console/board.md","columns":[]}""")
                else -> MockResponse().setResponseCode(404)
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
    private val card = SpacesRepository.CardView(
        text = "Can't attach images", column = "In Progress", agentKey = null, blockId = "odd-owl", blocked = false, checked = false,
        detail = emptyList(),
    )

    @Test
    fun `posts the image as base64 to the attach verb, addressed by block id, and returns the asset`() = runBlocking {
        attachResponse = MockResponse().setBody("""{"text":"Can't attach images","column":"In Progress","asset":"board/card-1-odd-owl.jpg"}""")
        val bytes = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x00, 0x7F)
        val asset = repo().attachImage("console", card, bytes, "jpg", caption = "img")
        assertEquals("board/card-1-odd-owl.jpg", asset)

        val req = attachRequests.poll(10, java.util.concurrent.TimeUnit.SECONDS) ?: throw AssertionError("no attach request")
        assertEquals("POST", req.method)
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("^odd-owl", body["card"]!!.jsonPrimitive.content)
        assertEquals("jpg", body["ext"]!!.jsonPrimitive.content)
        assertEquals("img", body["caption"]!!.jsonPrimitive.content)
        assertArrayEquals(bytes, java.util.Base64.getDecoder().decode(body["image"]!!.jsonPrimitive.content))
    }

    @Test
    fun `a hub error surfaces on boardError and yields no asset`() = runBlocking {
        attachResponse = MockResponse().setBody("""{"error":"unsupported attachment type \"bmp\""}""")
        val r = repo()
        assertNull(r.attachImage("console", card, byteArrayOf(1), "bmp"))
        assertNotNull(r.boardError.value)
        assertEquals(true, r.boardError.value!!.contains("unsupported"))
    }

    @Test
    fun `a failed mutation's error survives the post-mutation board reload`() = runBlocking {
        // The board GET succeeds (200 above); before the fix that reload cleared
        // boardError and the banner never showed while the hub was up.
        moveResponse = MockResponse().setBody("""{"error":"card not found"}""")
        val r = repo()
        assertEquals(false, r.moveCard("console", card, "Done"))
        assertEquals("card not found", r.boardError.value)
        assertNotNull(r.board.value)
    }
}
