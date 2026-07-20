package io.amar.console.ui.agents

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.Locale

/**
 * Read-aloud (TTS) for agent text blocks — the mobile analogue of the SPA's
 * `speechSynthesis` path (AgentMessageBlock.tsx). Uses Android's on-device
 * [TextToSpeech]; no hub round-trip needed (unlike the SPA's espeak-ng
 * fallback for Linux browsers without voices).
 *
 * [speakingId] is the message id currently being spoken (null = idle) so each
 * block can show a Stop glyph while it (and only it) is talking.
 */
object Speech {
    private var tts: TextToSpeech? = null
    @Volatile private var ready = false

    private val _speakingId = MutableStateFlow<String?>(null)
    val speakingId: StateFlow<String?> = _speakingId

    /** Idempotent; call from any Context (uses app context). */
    fun init(context: Context) {
        if (tts != null) return
        val app = context.applicationContext
        tts = TextToSpeech(app) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                runCatching { tts?.language = Locale.getDefault() }
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        if (_speakingId.value == utteranceId) _speakingId.value = null
                    }
                    @Deprecated("deprecated in API 21")
                    override fun onError(utteranceId: String?) {
                        if (_speakingId.value == utteranceId) _speakingId.value = null
                    }
                })
            }
        }
    }

    /** Speak [text] for message [id]; toggles off if already speaking it. */
    fun toggle(id: String, text: String, context: Context) {
        init(context)
        if (_speakingId.value == id) { stop(); return }
        val engine = tts ?: return
        if (!ready) return
        _speakingId.value = id
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
    }

    fun stop() {
        tts?.stop()
        _speakingId.value = null
    }
}
