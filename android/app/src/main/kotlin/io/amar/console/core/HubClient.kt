package io.amar.console.core

import io.amar.console.HubTokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Bearer-authed REST client for the hub. One OkHttp client for the whole app
 * (connection pooling); WS clients (PushService, SyncBusClient) hold their own
 * because their timeout profiles differ.
 */
class HubClient(
    val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        // Net events → DebugAgent so failed hub calls show in /debug/log.
        .addInterceptor { chain ->
            val started = System.currentTimeMillis()
            val req = chain.request()
            try {
                val resp = chain.proceed(req)
                DebugAgent.log(
                    "net", method = req.method, url = req.url.encodedPath,
                    status = resp.code, duration = System.currentTimeMillis() - started,
                )
                resp
            } catch (e: java.io.IOException) {
                DebugAgent.log(
                    "net", method = req.method, url = req.url.encodedPath,
                    status = -1, duration = System.currentTimeMillis() - started,
                    message = e.message,
                )
                throw e
            }
        }
        .build(),
) {

    class HttpException(val code: Int, val body: String) : IOException("HTTP $code: ${body.take(200)}")

    private fun request(path: String): Request.Builder {
        val url = if (path.startsWith("http")) path else "${HubConfig.hubBase}$path"
        val b = Request.Builder().url(url)
        HubTokenStore.get()?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    private suspend fun execute(req: Request): String = withContext(Dispatchers.IO) {
        suspendCancellableCoroutine { cont ->
            val call = okHttp.newCall(req)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val body = it.body?.string() ?: ""
                        if (!it.isSuccessful) {
                            if (cont.isActive) cont.resumeWithException(HttpException(it.code, body))
                        } else {
                            if (cont.isActive) cont.resume(body)
                        }
                    }
                }
            })
        }
    }

    suspend fun get(path: String): String = execute(request(path).get().build())

    suspend fun post(path: String, json: String = "{}"): String =
        execute(request(path).post(json.toRequestBody(JSON)).build())

    suspend fun put(path: String, json: String): String =
        execute(request(path).put(json.toRequestBody(JSON)).build())

    suspend fun patch(path: String, json: String): String =
        execute(request(path).patch(json.toRequestBody(JSON)).build())

    suspend fun delete(path: String): String = execute(request(path).delete().build())

    /** Raw bytes (media, attachments). Caller owns closing the response. */
    suspend fun getRaw(path: String): Response = withContext(Dispatchers.IO) {
        val resp = okHttp.newCall(request(path).get().build()).execute()
        if (!resp.isSuccessful) {
            val body = resp.body?.string() ?: ""
            resp.close()
            throw HttpException(resp.code, body)
        }
        resp
    }

    companion object {
        private val JSON = "application/json".toMediaType()
    }
}
