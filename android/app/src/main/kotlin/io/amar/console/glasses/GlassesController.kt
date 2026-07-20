package io.amar.console.glasses

import android.content.Context

/**
 * Process-wide facade around [BleManager]. Both `GlassesService` and
 * `MainActivity.ConsoleBridge` go through this object, so there's a single
 * stable handle independent of Activity/Service lifecycle.
 *
 * Initialise exactly once from `GlassesService.onCreate()`. Subsequent
 * `init()` calls are no-ops.
 */
object GlassesController {

    @Volatile private var ble: BleManager? = null

    fun init(ctx: Context) {
        if (ble != null) return
        synchronized(this) {
            if (ble != null) return
            val m = BleManager(ctx.applicationContext)
            ble = m
            // Feed the semantic event pipeline (ring buffer + head-down mirror
            // re-assert + /debug/log) from every parsed 0xF5 touch frame. The
            // native twin of src/glasses/events.ts's DOM-event subscription.
            m.addListener(object : BleManager.Listener {
                override fun onTouch(arm: G1Protocol.Arm, subcmd: Byte) {
                    GlassesEvents.record(arm, subcmd)
                }
            })
            m.start()
        }
    }

    fun requireBle(): BleManager =
        ble ?: error("GlassesController.init(context) has not been called")

    fun isReady(): Boolean = ble != null

    // --- Thin pass-through helpers (keep API surface aligned with the JS bridge) ---

    fun sendText(text: String, onResult: ((BleManager.AckOutcome) -> Unit)? = null) =
        requireBle().sendText(text, onResult)

    fun sendExit(onResult: ((BleManager.AckOutcome) -> Unit)? = null) =
        requireBle().sendExit(onResult)

    fun sendBmp(bmp: ByteArray, onResult: ((BleManager.BmpResult) -> Unit)? = null) =
        requireBle().sendBmp(bmp, onResult)

    fun sendNotification(msgId: Int, json: String, onResult: ((BleManager.AckOutcome) -> Unit)? = null) =
        requireBle().sendNotification(msgId, json, onResult)

    fun setMic(enable: Boolean, onResult: ((BleManager.AckOutcome) -> Unit)? = null) =
        requireBle().setMic(enable, onResult)

    fun scan(durationMs: Long = 15_000L) = requireBle().startScan(durationMs)
    fun stopScan() = requireBle().stopScan()
    fun pair(leftMac: String, rightMac: String, channel: String) =
        requireBle().pairAndConnect(leftMac, rightMac, channel)
    fun unpair() = requireBle().unpair()

    /** Temporarily sever the BLE link, keeping the saved pair (SPA "Pause"). */
    fun disconnect() = requireBle().disconnect()

    /** Reconnect the saved pair with no scan (SPA "Connect"). */
    fun reconnect() = requireBle().reconnect()

    fun clear(onResult: ((BleManager.AckOutcome) -> Unit)? = null) = requireBle().sendExit(onResult)
}
