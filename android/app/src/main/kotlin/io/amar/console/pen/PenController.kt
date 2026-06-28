package io.amar.console.pen

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Process-wide facade over the single PenBleManager. Mirrors GlassesController. */
object PenController {
    @Volatile private var ble: PenBleManager? = null

    fun init(ctx: Context) {
        if (ble != null) return
        synchronized(this) {
            if (ble != null) return
            val m = PenBleManager(ctx.applicationContext)
            ble = m
            m.start()
        }
    }

    fun isReady(): Boolean = ble != null
    fun requireBle(): PenBleManager = ble ?: error("PenController.init() not called")

    fun connect(mac: String?) = requireBle().connect(mac)
    fun disconnect() = requireBle().disconnect()
    fun startScan(durationMs: Long = 15_000L) = requireBle().startScan(durationMs)
    fun stopScan() = requireBle().stopScan()
    fun sendPassword(pw: String) = requireBle().sendPassword(pw)
    fun reqOfflineNotes() = requireBle().reqOfflineNotes()
    fun reqOfflinePages(section: Int, owner: Int, note: Long) = requireBle().reqOfflinePages(section, owner, note)
    fun pullPage(section: Int, owner: Int, note: Long, page: Long) = requireBle().pullPage(section, owner, note, page)
    fun sendRaw(cmd: Int, data: ByteArray): Boolean = requireBle().sendRaw(cmd, data)

    /** Bonded BLE devices that look like a Neo pen (have the 0x19F1 service or a NWP/Neo name). */
    fun listDevices(): JSONArray = requireBle().listBondedPens()

    fun status(): JSONObject = PenState.toJson()
}
