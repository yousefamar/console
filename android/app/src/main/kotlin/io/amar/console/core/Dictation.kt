package io.amar.console.core

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import io.amar.console.HubTokenStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Composer dictation — mic → hub /stt (OpenAI realtime) → live transcript.
 * Same pipeline as PushService's PTT capture, but UI-driven: hold the state
 * here, screens render [transcript] into their composer. Requires
 * RECORD_AUDIO (MainActivity requests it on first use).
 */
object Dictation {
    data class State(
        val active: Boolean = false,
        val transcript: String = "",   // finals + current interim
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    /** Committed transcripts (fired from [stop]). The active composer collects
     *  this and appends to its draft — so BOTH the in-composer mic button and
     *  the hardware PTT key (PushService) land text the same way. */
    private val _committed = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 4)
    val committed: kotlinx.coroutines.flow.SharedFlow<String> = _committed

    private var ws: WebSocket? = null
    private var record: AudioRecord? = null
    @Volatile private var running = false
    private val finals = StringBuilder()
    @Volatile private var interim = ""

    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private fun publish() {
        _state.value = _state.value.copy(
            transcript = (finals.toString() + interim).trim().replace(Regex("\\s+"), " "),
        )
    }

    @SuppressLint("MissingPermission") // caller checks RECORD_AUDIO
    fun start() {
        if (running) return
        running = true
        finals.setLength(0); interim = ""
        _state.value = State(active = true)

        val builder = Request.Builder().url(HubConfig.sttWsUrl)
        HubTokenStore.get()?.let { builder.header("Authorization", "Bearer $it") }
        ws = okHttp.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val m = JSONObject(text)
                    when (m.optString("type")) {
                        // Interims stream as incremental DELTAS (same wire as
                        // PushService PTT) — accumulate or you only ever see
                        // the newest word.
                        "interim" -> { interim += m.optString("text"); publish() }
                        "final" -> {
                            val t = m.optString("text")
                            if (t.isNotEmpty()) finals.append(t).append(' ')
                            interim = ""
                            publish()
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _state.value = _state.value.copy(error = t.message ?: "stt failed")
            }
        })

        val sr = 24000
        val minBuf = AudioRecord.getMinBufferSize(sr, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION, sr,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf, sr / 5 * 2),
            )
        } catch (e: Throwable) {
            _state.value = State(active = false, error = "mic unavailable")
            running = false
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { rec.release() }
            _state.value = State(active = false, error = "mic init failed")
            running = false
            return
        }
        record = rec
        rec.startRecording()
        Thread {
            val buf = ByteArray(sr / 20 * 2) // ~50ms frames
            while (running) {
                val n = try { rec.read(buf, 0, buf.size) } catch (_: Throwable) { -1 }
                if (n > 0) {
                    val b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                    runCatching { ws?.send(JSONObject().put("type", "audio").put("data", b64).toString()) }
                } else if (n < 0) break
            }
        }.start()
    }

    /** Stop and commit the final transcript (after a short flush grace). The
     *  text is emitted on [committed]; the optional callback also receives it. */
    fun stop(onDone: (String) -> Unit = {}) {
        if (!running) { onDone(""); return }
        running = false
        runCatching { record?.stop(); record?.release() }
        record = null
        // Give the STT a beat to flush the trailing final (same 700ms as PTT).
        Thread {
            Thread.sleep(700)
            runCatching { ws?.close(1000, "dictation-end") }
            ws = null
            val text = _state.value.transcript
            _state.value = State()
            if (text.isNotEmpty()) _committed.tryEmit(text)
            onDone(text)
        }.start()
    }

    fun cancel() {
        running = false
        runCatching { record?.stop(); record?.release() }
        record = null
        runCatching { ws?.close(1000, "cancel") }
        ws = null
        _state.value = State()
    }
}
