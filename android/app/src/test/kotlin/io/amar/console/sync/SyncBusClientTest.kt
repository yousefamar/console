package io.amar.console.sync

import io.amar.console.core.HubConfig
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * SyncBusClient against a real (loopback) WS server: sub-on-connect, evt
 * dispatch, RPC round-trip + error, reconnect-with-resub after server drop.
 */
@RunWith(RobolectricTestRunner::class)
class SyncBusClientTest {

    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope
    private lateinit var client: SyncBusClient

    /** Server-side handle for the currently-open socket + inbound frames. */
    private val serverSockets = LinkedBlockingQueue<WebSocket>()
    private val inbound = LinkedBlockingQueue<String>()

    private fun wsListener() = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
            serverSockets.add(webSocket)
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            inbound.add(text)
        }
    }

    @Before
    fun setUp() {
        HubConfig.init(ApplicationProvider.getApplicationContext())
        server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(wsListener()))
        server.start()
        // Point the client at the mock server (http → the client's ws rewrite).
        HubConfig.setHubBase(server.url("/hub").toString())
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        client = SyncBusClient(scope)
    }

    @After
    fun tearDown() {
        client.stop()
        scope.cancel()
        // Close any server-side sockets so MockWebServer's dispatcher queue can
        // wind down; otherwise shutdown() blocks its full 60s grace period.
        while (true) {
            val s = serverSockets.poll() ?: break
            runCatching { s.cancel() }
        }
        runCatching { server.shutdown() }
        HubConfig.setHubBase("") // restore default
    }

    private fun awaitConnected(timeoutMs: Long = 5000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!client.connected && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertTrue("client should connect", client.connected)
    }

    @Test
    fun `subscribes on connect and dispatches evt to handler`() {
        val received = LinkedBlockingQueue<String>()
        client.on("chat-rooms", "delta") { data ->
            received.add(data.jsonObject["seq"]!!.jsonPrimitive.content)
        }
        client.start()
        awaitConnected()

        // Server should see the sub frame.
        val sub = inbound.poll(3, TimeUnit.SECONDS)
        assertEquals("sub", JSONObject(sub!!).getString("t"))
        assertEquals("chat-rooms", JSONObject(sub).getString("service"))

        // Push an evt; handler must fire.
        serverSockets.peek()!!.send(
            """{"t":"evt","service":"chat-rooms","op":"delta","data":{"seq":7}}"""
        )
        assertEquals("7", received.poll(3, TimeUnit.SECONDS))
    }

    @Test
    fun `rpc round trip resolves with result`() = runBlocking {
        client.start()
        awaitConnected()
        // Answer the next rpc frame server-side.
        Thread {
            val frame = inbound.poll(3, TimeUnit.SECONDS) ?: return@Thread
            val msg = JSONObject(frame)
            if (msg.getString("t") == "rpc") {
                serverSockets.peek()!!.send(
                    """{"t":"rpc","id":${msg.getLong("id")},"ok":true,"result":{"answer":42}}"""
                )
            }
        }.start()
        val result = withTimeout(5000) {
            client.rpc("matrix", "resume", buildJsonObject { put("since", "s1") })
        }
        assertEquals("42", result.jsonObject["answer"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rpc error rejects`() = runBlocking {
        client.start()
        awaitConnected()
        Thread {
            val frame = inbound.poll(3, TimeUnit.SECONDS) ?: return@Thread
            val msg = JSONObject(frame)
            serverSockets.peek()!!.send(
                """{"t":"rpc","id":${msg.getLong("id")},"ok":false,"error":"no such op"}"""
            )
        }.start()
        val failed = runCatching {
            withTimeout(5000) { client.rpc("matrix", "nope") }
        }
        assertTrue(failed.isFailure)
        assertEquals("no such op", failed.exceptionOrNull()?.message)
    }

    @Test
    fun `reconnects and re-subscribes after server drop`() {
        val connects = CountDownLatch(2)
        client.onConnect { connects.countDown() }
        client.on("mail", "delta") { }
        // Enqueue the reconnect upgrade BEFORE the drop so the client's retry
        // (500ms backoff) always finds a pending response.
        server.enqueue(MockResponse().withWebSocketUpgrade(wsListener()))
        client.start()
        awaitConnected()
        inbound.poll(3, TimeUnit.SECONDS) // first sub frame

        serverSockets.poll()!!.close(1001, "server restart")

        assertTrue("should reconnect", connects.await(10, TimeUnit.SECONDS))
        val resub = inbound.poll(5, TimeUnit.SECONDS)
        assertEquals("mail", JSONObject(resub!!).getString("service"))
    }
}
