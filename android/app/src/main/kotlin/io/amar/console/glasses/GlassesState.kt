package io.amar.console.glasses

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Process-wide, thread-safe snapshot of the glasses subsystem.
 *
 * Exposed via a static singleton because `GlassesService` and
 * `MainActivity.ConsoleBridge` live in the same process and both want to read
 * (and the service wants to write) this state. No IPC or Binder needed.
 *
 * Observers are notified after any mutation; the JS bridge uses this to push
 * `console:glasses:state` events into the WebView.
 */
object GlassesState {

    enum class ArmStatus { DISCONNECTED, CONNECTING, CONNECTED }

    @Volatile var leftStatus: ArmStatus = ArmStatus.DISCONNECTED
        private set
    @Volatile var rightStatus: ArmStatus = ArmStatus.DISCONNECTED
        private set
    @Volatile var leftMac: String? = null
        private set
    @Volatile var rightMac: String? = null
        private set
    @Volatile var channel: String? = null
        private set

    /** Battery % 0..100, or null if unknown. Populated from 0x2C poll replies. */
    @Volatile var batteryLeft: Int? = null
        private set
    @Volatile var batteryRight: Int? = null
        private set

    /**
     * Whether the glasses are currently worn on the user's head. Populated
     * from unsolicited 0x27 wear events (see `docs/g1-protocol.md` §12).
     * Null = unknown (no event received yet, or wear detection disabled).
     */
    @Volatile var worn: Boolean? = null
        private set

    /** Charging-case battery % (0..100) from `0xF5` subcmd `0x0F`. */
    @Volatile var caseBattery: Int? = null
        private set

    /** Case charging state from `0xF5` subcmd `0x0E`. */
    @Volatile var caseCharging: Boolean? = null
        private set

    @Volatile var firmwareLeft: String? = null
        private set
    @Volatile var firmwareRight: String? = null
        private set

    @Volatile var serialLeft: String? = null
        private set
    @Volatile var serialRight: String? = null
        private set

    @Volatile var micActive: Boolean = false
        private set

    @Volatile var lastError: String? = null
        private set

    @Volatile var lastUpdatedMs: Long = 0L
        private set

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    // --- Mutations (package-private, called by BleManager / GlassesService) -

    @Synchronized
    internal fun setArmStatus(arm: G1Protocol.Arm, status: ArmStatus, mac: String? = null) {
        when (arm) {
            G1Protocol.Arm.LEFT -> {
                leftStatus = status
                if (mac != null) leftMac = mac
                if (status == ArmStatus.DISCONNECTED) {
                    batteryLeft = null
                    firmwareLeft = null
                    serialLeft = null
                }
            }
            G1Protocol.Arm.RIGHT -> {
                rightStatus = status
                if (mac != null) rightMac = mac
                if (status == ArmStatus.DISCONNECTED) {
                    batteryRight = null
                    firmwareRight = null
                    serialRight = null
                }
            }
        }
        touch()
    }

    @Synchronized
    internal fun setPair(leftMac: String?, rightMac: String?, channel: String?) {
        this.leftMac = leftMac
        this.rightMac = rightMac
        this.channel = channel
        touch()
    }

    @Synchronized
    internal fun setMicActive(active: Boolean) {
        micActive = active
        touch()
    }

    @Synchronized
    internal fun setBattery(arm: G1Protocol.Arm, percent: Int?) {
        when (arm) {
            G1Protocol.Arm.LEFT -> batteryLeft = percent
            G1Protocol.Arm.RIGHT -> batteryRight = percent
        }
        touch()
    }

    @Synchronized
    internal fun setSerial(arm: G1Protocol.Arm, sn: String?) {
        when (arm) {
            G1Protocol.Arm.LEFT -> serialLeft = sn
            G1Protocol.Arm.RIGHT -> serialRight = sn
        }
        touch()
    }

    @Synchronized
    internal fun setWorn(value: Boolean?) {
        worn = value
        touch()
    }

    @Synchronized
    internal fun setCaseBattery(pct: Int?) {
        caseBattery = pct
        touch()
    }

    @Synchronized
    internal fun setCaseCharging(value: Boolean?) {
        caseCharging = value
        touch()
    }

    @Synchronized
    internal fun setError(msg: String?) {
        lastError = msg
        touch()
    }

    @Synchronized
    internal fun clearPair() {
        leftMac = null
        rightMac = null
        channel = null
        batteryLeft = null
        batteryRight = null
        firmwareLeft = null
        firmwareRight = null
        serialLeft = null
        serialRight = null
        worn = null
        caseBattery = null
        caseCharging = null
        leftStatus = ArmStatus.DISCONNECTED
        rightStatus = ArmStatus.DISCONNECTED
        touch()
    }

    private fun touch() {
        lastUpdatedMs = System.currentTimeMillis()
        for (l in listeners) {
            try { l() } catch (_: Throwable) { /* ignore listener crashes */ }
        }
    }

    val connected: Boolean
        get() = leftStatus == ArmStatus.CONNECTED && rightStatus == ArmStatus.CONNECTED

    fun toJson(): JSONObject {
        val root = JSONObject()
        root.put("connected", connected)
        root.put("left", JSONObject().apply {
            put("status", leftStatus.name.lowercase())
            put("mac", leftMac ?: JSONObject.NULL)
            put("battery", batteryLeft ?: JSONObject.NULL)
            put("firmware", firmwareLeft ?: JSONObject.NULL)
            put("serial", serialLeft ?: JSONObject.NULL)
        })
        root.put("right", JSONObject().apply {
            put("status", rightStatus.name.lowercase())
            put("mac", rightMac ?: JSONObject.NULL)
            put("battery", batteryRight ?: JSONObject.NULL)
            put("firmware", firmwareRight ?: JSONObject.NULL)
            put("serial", serialRight ?: JSONObject.NULL)
        })
        root.put("channel", channel ?: JSONObject.NULL)
        root.put("micActive", micActive)
        root.put("worn", worn ?: JSONObject.NULL)
        root.put("caseBattery", caseBattery ?: JSONObject.NULL)
        root.put("caseCharging", caseCharging ?: JSONObject.NULL)
        root.put("lastError", lastError ?: JSONObject.NULL)
        root.put("lastUpdatedMs", lastUpdatedMs)
        return root
    }

    // --- Scan results bag (not persistent; cleared on scan start) ----------

    data class ScanCandidate(val channel: String, val leftMac: String?, val rightMac: String?, val rssi: Int?)
    @Volatile private var scanCandidates: Map<String, ScanCandidate> = emptyMap()

    @Synchronized
    internal fun replaceScanCandidates(map: Map<String, ScanCandidate>) {
        scanCandidates = map
        touch()
    }

    fun scanCandidatesJson(): JSONArray {
        val arr = JSONArray()
        for ((_, c) in scanCandidates) {
            arr.put(JSONObject().apply {
                put("channel", c.channel)
                put("leftMac", c.leftMac ?: JSONObject.NULL)
                put("rightMac", c.rightMac ?: JSONObject.NULL)
                put("rssi", c.rssi ?: JSONObject.NULL)
                put("ready", c.leftMac != null && c.rightMac != null)
            })
        }
        return arr
    }
}
