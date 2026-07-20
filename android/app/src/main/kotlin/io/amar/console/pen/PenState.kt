package io.amar.console.pen

import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Process-wide single-pen connection snapshot. Mirrors glasses/GlassesState but
 * single-device. Read by PenService (ongoing notification) and serialized to the
 * hub via PushService `pen_status`.
 */
object PenState {
    enum class Status { DISCONNECTED, CONNECTING, CONNECTED }

    @Volatile var status: Status = Status.DISCONNECTED; private set
    @Volatile var mac: String? = null; private set
    @Volatile var name: String? = null; private set
    @Volatile var firmware: String? = null; private set
    @Volatile var battery: Int? = null; private set
    @Volatile var usedMemPct: Int? = null; private set
    @Volatile var locked: Boolean = false; private set
    @Volatile var authorized: Boolean = false; private set
    @Volatile var offlineSaveOn: Boolean? = null; private set
    @Volatile var lastError: String? = null; private set
    @Volatile var lastDotX: Float? = null; private set
    @Volatile var lastDotY: Float? = null; private set
    @Volatile var lastUpdatedMs: Long = 0L; private set

    /** Whether a BLE scan is currently in flight (drives the settings spinner). */
    @Volatile var scanning: Boolean = false; private set

    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    // --- Scan observation bag (transient; cleared on scan start) -------------

    data class ScanObservation(val name: String, val mac: String, val rssi: Int, val has19f1: Boolean)
    @Volatile private var scanObservations: Map<String, ScanObservation> = emptyMap()

    @Synchronized fun setScanning(v: Boolean) { scanning = v; touch() }

    @Synchronized fun clearScanObservations() { scanObservations = emptyMap(); touch() }

    @Synchronized fun addScanObservation(o: ScanObservation) {
        // Key by MAC; keep the strongest RSSI seen for a device.
        val existing = scanObservations[o.mac]
        if (existing == null || o.rssi > existing.rssi) {
            scanObservations = scanObservations + (o.mac to o)
            touch()
        }
    }

    /** Newest/strongest-first observations for the settings pair list. */
    fun scanObservationsList(): List<ScanObservation> =
        scanObservations.values.sortedByDescending { it.rssi }

    @Synchronized fun setStatus(s: Status, mac: String? = this.mac) {
        status = s; this.mac = mac
        if (s == Status.DISCONNECTED) { authorized = false }
        touch()
    }
    @Synchronized fun setPenInfo(name: String?, firmware: String?) { this.name = name; this.firmware = firmware; touch() }
    @Synchronized fun setBattery(pct: Int?) { battery = pct; touch() }
    @Synchronized fun setStorage(pct: Int?) { usedMemPct = pct; touch() }
    @Synchronized fun setLocked(v: Boolean) { locked = v; touch() }
    @Synchronized fun setAuthorized(v: Boolean) { authorized = v; touch() }
    @Synchronized fun setOfflineSave(v: Boolean?) { offlineSaveOn = v; touch() }
    @Synchronized fun setError(msg: String?) { lastError = msg; touch() }
    @Synchronized fun setLastDot(x: Float, y: Float) { lastDotX = x; lastDotY = y; touch() }

    fun toJson(): JSONObject = JSONObject().apply {
        put("status", status.name.lowercase())
        put("mac", mac ?: JSONObject.NULL)
        put("name", name ?: JSONObject.NULL)
        put("firmware", firmware ?: JSONObject.NULL)
        put("battery", battery ?: JSONObject.NULL)
        put("usedMemPct", usedMemPct ?: JSONObject.NULL)
        put("locked", locked)
        put("authorized", authorized)
        put("offlineSaveOn", offlineSaveOn ?: JSONObject.NULL)
        put("lastError", lastError ?: JSONObject.NULL)
        put("lastDotX", lastDotX?.toDouble() ?: JSONObject.NULL)
        put("lastDotY", lastDotY?.toDouble() ?: JSONObject.NULL)
        put("lastUpdatedMs", lastUpdatedMs)
    }

    private fun touch() {
        lastUpdatedMs = System.currentTimeMillis()
        for (l in listeners) { try { l() } catch (_: Throwable) {} }
    }
}
