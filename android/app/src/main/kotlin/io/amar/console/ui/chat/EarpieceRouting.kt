package io.amar.console.ui.chat

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * WhatsApp-style earpiece routing for voice messages: while a message is
 * playing, watch the proximity sensor; phone at the ear → route playback to
 * the earpiece and blank the screen (PROXIMITY_SCREEN_OFF wake lock, same as
 * calls, so a cheek can't tap the UI); away from the ear → speaker again.
 *
 * Reference-counted so overlapping bubbles share one sensor registration.
 * [near] flips are consumed by AudioBubble, which rebuilds its MediaPlayer
 * with voice-call audio attributes at the same position (attributes can't be
 * changed on a live player — the Telegram/WhatsApp rebuild trick).
 */
object EarpieceRouting {
    private val _near = MutableStateFlow(false)
    val near: StateFlow<Boolean> = _near

    private var sensorManager: SensorManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var refCount = 0

    private val listener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val sensor = event.sensor ?: return
            _near.value = event.values.firstOrNull()?.let { it < sensor.maximumRange } == true
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    /** Call when a voice message starts playing. */
    fun start(ctx: Context) {
        synchronized(this) {
            if (refCount++ > 0) return
            val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
            val prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY) ?: return
            sensorManager = sm
            sm.registerListener(listener, prox, SensorManager.SENSOR_DELAY_NORMAL)
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm?.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) == true) {
                wakeLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "console:voiceNote").apply {
                    setReferenceCounted(false)
                    runCatching { acquire(10 * 60 * 1000L) }
                }
            }
        }
    }

    /** Call when playback stops/pauses/disposes. */
    fun stop(ctx: Context) {
        synchronized(this) {
            if (refCount == 0 || --refCount > 0) return
            sensorManager?.unregisterListener(listener)
            sensorManager = null
            runCatching { wakeLock?.let { if (it.isHeld) it.release() } }
            wakeLock = null
            _near.value = false
            restoreSpeaker(ctx)
        }
    }

    /** Route the audio session to the earpiece (voice-call path). */
    fun routeEarpiece(ctx: Context) {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        runCatching {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.availableCommunicationDevices
                    .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    ?.let { am.setCommunicationDevice(it) }
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
            }
        }
    }

    fun restoreSpeaker(ctx: Context) {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
            else @Suppress("DEPRECATION") { am.isSpeakerphoneOn = true }
            am.mode = AudioManager.MODE_NORMAL
        }
    }

    /** Audio attributes for the current route: earpiece playback must use the
     *  voice-communication usage or the player stays on the media stream. */
    fun attributesFor(near: Boolean): AudioAttributes =
        if (near) AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        else AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
}
