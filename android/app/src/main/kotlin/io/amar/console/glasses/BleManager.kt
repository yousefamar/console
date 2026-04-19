package io.amar.console.glasses

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.atomic.AtomicInteger

/**
 * Dual-arm GATT orchestrator for G1 glasses.
 *
 * Responsibilities:
 * - Scan for G1 advertisements, aggregate into channel-matched pairs, emit
 *   candidate events while scanning.
 * - Connect to left + right arms as two independent GATT sessions.
 * - Per-arm serialized write queue with 5 ms inter-packet delay.
 * - Per-arm ack matcher for commands that expect a `0xC9` / `0xCA` reply.
 * - L-then-R sequencing helper (send to L, await ack, then send to R).
 *   BMP upload is the documented exception — caller uses the parallel helper.
 * - Heartbeat every 8 s on both arms.
 * - Notification dispatch: ack matcher → audio callback → touchbar callback.
 * - Auto-reconnect with exponential backoff.
 *
 * This class is a process-wide singleton; instantiate once from
 * `GlassesService` and keep alive for the service lifetime.
 */
@SuppressLint("MissingPermission")
class BleManager(private val app: Context) {

    // --- External event surface ---------------------------------------------

    /** Callbacks emitted on arbitrary threads. Listener must be thread-safe. */
    interface Listener {
        /** Inbound `0xF1` audio frame (200 bytes LC3, right-arm only). */
        fun onAudioFrame(seq: Int, lc3Bytes: ByteArray) {}
        /** Inbound `0xF5` touchbar event from a given arm. */
        fun onTouch(arm: G1Protocol.Arm, subcmd: Byte) {}
        /** Inbound anything-else for debugging / future opcode wiring. */
        fun onUnhandled(arm: G1Protocol.Arm, data: ByteArray) {}
        /**
         * Every inbound BLE frame, classified. Emitted *before* the dispatch
         * callbacks above so a logger gets a complete view. Used by the hub's
         * reverse-engineering pipeline — see `docs/g1-protocol.md`.
         *
         * `kind` is one of:
         *   "audio"     — 0xF1 LC3 audio (200 bytes post-header)
         *   "touch"     — 0xF5 touchbar event
         *   "heartbeat" — 0x25 response
         *   "ack"       — matched the in-flight write's expected opcode
         *   "unhandled" — nothing in the APK claimed it; likely unknown opcode
         */
        fun onFrame(arm: G1Protocol.Arm, data: ByteArray, kind: String) {}
        /** Connection state changes, already mirrored into GlassesState. */
        fun onStateChange() {}
        /** Surfaced for telemetry / toasts. */
        fun onError(msg: String) {}
        /**
         * Every BLE advertisement with a non-empty name seen during a scan,
         * regardless of whether it matched the G1 naming convention. Used by
         * the diagnostic pipeline to reveal what's actually in range when
         * `parseDeviceName` rejects everything.
         */
        fun onScanObservation(name: String, mac: String, rssi: Int) {}
    }

    private val listeners = java.util.concurrent.CopyOnWriteArrayList<Listener>()
    fun addListener(l: Listener) { listeners.add(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }

    // --- Threading ----------------------------------------------------------

    /** Single shared worker thread for all BLE ops (serialize everything). */
    private val workerThread = HandlerThread("glasses-ble").apply { start() }
    private val worker = Handler(workerThread.looper)

    // --- Per-arm state ------------------------------------------------------

    private class Arm(val side: G1Protocol.Arm) {
        var gatt: BluetoothGatt? = null
        var tx: BluetoothGattCharacteristic? = null
        var rx: BluetoothGattCharacteristic? = null
        val queue: ConcurrentLinkedDeque<WriteOp> = ConcurrentLinkedDeque()
        var inflight: WriteOp? = null
        var reconnectDelayMs: Long = RECONNECT_MIN_MS
        var reconnectPending: Boolean = false
        /** Monotonic sequence for heartbeat packets. */
        var heartbeatSeq: Int = 0
    }

    private data class WriteOp(
        val bytes: ByteArray,
        /** If set, we wait for a matching ack opcode before processing the next op. */
        val expectAckOpcode: Byte? = null,
        val ackTimeoutMs: Long = DEFAULT_ACK_TIMEOUT_MS,
        val onResult: ((AckOutcome) -> Unit)? = null,
    )

    sealed class AckOutcome {
        data class Ok(val payload: ByteArray) : AckOutcome()
        data class Fail(val payload: ByteArray) : AckOutcome()
        object Timeout : AckOutcome()
        data class WriteFailed(val reason: String) : AckOutcome()
    }

    private val left = Arm(G1Protocol.Arm.LEFT)
    private val right = Arm(G1Protocol.Arm.RIGHT)

    /** Monotonic text sync-seq, wraps mod 256. */
    private val textSeq = AtomicInteger(0)

    // --- Lifecycle ----------------------------------------------------------

    private val btManager: BluetoothManager? by lazy {
        app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    }
    private val adapter: BluetoothAdapter? get() = btManager?.adapter

    @Volatile private var started = false
    @Volatile private var heartbeatRunnable: Runnable? = null
    /** Counts heartbeat ticks; every Nth tick we piggyback a battery poll. */
    private var heartbeatTickCount: Int = 0
    @Volatile private var btReceiverRegistered = false

    /**
     * Watches the system Bluetooth adapter state. Without this, turning
     * BT off leaves both arms stuck on "connecting" forever because
     * `connectGatt` returns a stub that never calls back. When BT comes
     * back on we resume auto-reconnect from the pair store.
     */
    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            val state = intent.getIntExtra(
                BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR,
            )
            when (state) {
                BluetoothAdapter.STATE_OFF, BluetoothAdapter.STATE_TURNING_OFF -> {
                    worker.post { onBluetoothDisabled() }
                }
                BluetoothAdapter.STATE_ON -> {
                    worker.post { onBluetoothEnabled() }
                }
            }
        }
    }

    fun start() {
        if (started) return
        started = true
        registerBluetoothStateReceiver()
        worker.post {
            if (adapter?.isEnabled != true) {
                onBluetoothDisabled()
            } else {
                autoConnectFromPairStore()
            }
        }
    }

    fun stop() {
        started = false
        unregisterBluetoothStateReceiver()
        worker.post {
            stopHeartbeat()
            disconnectInternal(left)
            disconnectInternal(right)
            stopScan()
        }
    }

    private fun registerBluetoothStateReceiver() {
        if (btReceiverRegistered) return
        try {
            app.registerReceiver(
                bluetoothStateReceiver,
                IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
            )
            btReceiverRegistered = true
        } catch (_: Throwable) { /* best effort */ }
    }

    private fun unregisterBluetoothStateReceiver() {
        if (!btReceiverRegistered) return
        try { app.unregisterReceiver(bluetoothStateReceiver) } catch (_: Throwable) {}
        btReceiverRegistered = false
    }

    /** Worker-thread handler for BT disabled: tear down, set clear error. */
    private fun onBluetoothDisabled() {
        stopHeartbeat()
        // Drop any pending reconnect timer; those would otherwise fire and
        // re-enter the "connecting" pit while BT is still off.
        left.reconnectPending = false
        right.reconnectPending = false
        disconnectInternal(left)
        disconnectInternal(right)
        GlassesState.setError("Bluetooth is off")
    }

    /** Worker-thread handler for BT re-enabled: clear error, retry auto-connect. */
    private fun onBluetoothEnabled() {
        if (!started) return
        // Only clear the error if it's the one we set — don't mask an
        // unrelated failure that happened to be current when BT came back.
        if (GlassesState.lastError == "Bluetooth is off") GlassesState.setError(null)
        autoConnectFromPairStore()
    }

    private fun autoConnectFromPairStore() {
        val store = PairStore(app)
        val pair = store.load() ?: return
        GlassesState.setPair(pair.leftMac, pair.rightMac, pair.channel)
        connectMac(pair.leftMac, G1Protocol.Arm.LEFT)
        connectMac(pair.rightMac, G1Protocol.Arm.RIGHT)
    }

    // --- Public API (called from GlassesController on worker thread) -------

    fun sendText(text: String, onResult: ((AckOutcome) -> Unit)? = null) {
        worker.post {
            val seq = textSeq.incrementAndGet() and 0xFF
            val packets = G1Protocol.encodeText(text, seq)
            // EvenDemoApp sends each chunk to L, awaits ack, then R. The last
            // chunk's ack is the overall completion signal for the caller.
            for ((idx, pkt) in packets.withIndex()) {
                val isLast = idx == packets.lastIndex
                enqueueSequenced(
                    pkt,
                    expectAck = G1Protocol.OP_TEXT,
                    onResult = if (isLast) onResult else null,
                )
            }
        }
    }

    fun sendExit(onResult: ((AckOutcome) -> Unit)? = null) {
        worker.post { enqueueSequenced(G1Protocol.encodeExit(), G1Protocol.OP_EXIT, onResult = onResult) }
    }

    fun sendNotification(msgId: Int, json: String, onResult: ((AckOutcome) -> Unit)? = null) {
        worker.post {
            val packets = G1Protocol.encodeNotificationChunks(msgId, json)
            for ((idx, pkt) in packets.withIndex()) {
                val isLast = idx == packets.lastIndex
                enqueueSequenced(
                    pkt,
                    expectAck = G1Protocol.OP_NOTIFICATION,
                    onResult = if (isLast) onResult else null,
                )
            }
        }
    }

    /** Mic is right-arm only. No left-side send at all. */
    fun setMic(enable: Boolean, onResult: ((AckOutcome) -> Unit)? = null) {
        worker.post {
            val pkt = G1Protocol.encodeMic(enable)
            enqueueRight(
                WriteOp(pkt, expectAckOpcode = G1Protocol.OP_MIC_CONTROL) { outcome ->
                    if (outcome is AckOutcome.Ok) GlassesState.setMicActive(enable)
                    onResult?.invoke(outcome)
                },
            )
        }
    }

    /**
     * BMP upload — special-cased because both arms run in parallel (EvenDemoApp's
     * only non-L-first operation).
     */
    fun sendBmp(bmp: ByteArray, onResult: ((BmpResult) -> Unit)? = null) {
        worker.post { doSendBmp(bmp, onResult) }
    }

    data class BmpResult(val leftOk: Boolean, val rightOk: Boolean, val error: String? = null)

    private fun doSendBmp(bmp: ByteArray, onResult: ((BmpResult) -> Unit)?) {
        val packets = G1Protocol.encodeBmpPackets(bmp)
        val end = G1Protocol.BMP_END_PACKET
        val crc = G1Protocol.bmpCrcPacket(bmp)

        // Track both arms' progress. All mutations happen on the BLE worker
        // thread (via enqueueOp → pump → worker.post), so plain vars are safe.
        var leftDone = false
        var rightDone = false
        var leftOk = false
        var rightOk = false
        var err: String? = null

        fun finalize() {
            if (leftDone && rightDone) {
                onResult?.invoke(BmpResult(leftOk, rightOk, err))
            }
        }

        fun runOnArm(arm: Arm) {
            // Stream data packets without per-packet ack.
            for (pkt in packets) {
                enqueueOp(arm, WriteOp(pkt))
            }
            // End marker with ack + retries (firmware is flaky here).
            enqueueOp(arm, WriteOp(end, expectAckOpcode = G1Protocol.OP_BMP_END, ackTimeoutMs = 3_000L) { endRes ->
                if (endRes !is AckOutcome.Ok) {
                    err = "end failed: $endRes"
                    if (arm.side == G1Protocol.Arm.LEFT) { leftDone = true; leftOk = false } else { rightDone = true; rightOk = false }
                    finalize()
                    return@WriteOp
                }
                // CRC packet.
                enqueueOp(arm, WriteOp(crc, expectAckOpcode = G1Protocol.OP_BMP_CRC, ackTimeoutMs = 3_000L) { crcRes ->
                    val ok = crcRes is AckOutcome.Ok
                    if (arm.side == G1Protocol.Arm.LEFT) { leftDone = true; leftOk = ok } else { rightDone = true; rightOk = ok }
                    if (!ok) err = "crc failed: $crcRes"
                    finalize()
                })
            })
        }

        runOnArm(left)
        runOnArm(right)
    }

    // --- Sequenced enqueue (L → await → R) ---------------------------------

    /**
     * Send `pkt` to L, then on L's ack (or timeout), send to R. Caller's
     * `onResult` is called with R's outcome (or L's outcome if L failed).
     */
    private fun enqueueSequenced(
        pkt: ByteArray,
        expectAck: Byte,
        onResult: ((AckOutcome) -> Unit)? = null,
    ) {
        enqueueOp(left, WriteOp(pkt, expectAckOpcode = expectAck) { leftOutcome ->
            if (leftOutcome !is AckOutcome.Ok) {
                onResult?.invoke(leftOutcome)
                // Still try R so the displays don't drift too far.
                enqueueOp(right, WriteOp(pkt, expectAckOpcode = expectAck))
                return@WriteOp
            }
            enqueueOp(right, WriteOp(pkt, expectAckOpcode = expectAck) { rightOutcome ->
                onResult?.invoke(rightOutcome)
            })
        })
    }

    private fun enqueueRight(op: WriteOp) = enqueueOp(right, op)

    private fun enqueueOp(arm: Arm, op: WriteOp) {
        arm.queue.addLast(op)
        pump(arm)
    }

    private fun pump(arm: Arm) {
        worker.post {
            if (arm.inflight != null) return@post
            val gatt = arm.gatt ?: return@post
            val tx = arm.tx ?: return@post
            if (GlassesState.run { if (arm.side == G1Protocol.Arm.LEFT) leftStatus else rightStatus } != GlassesState.ArmStatus.CONNECTED) {
                // Drop queue on disconnect; let caller decide to retry.
                val dropped = ArrayList<WriteOp>(arm.queue)
                arm.queue.clear()
                for (d in dropped) d.onResult?.invoke(AckOutcome.WriteFailed("disconnected"))
                return@post
            }
            val op = arm.queue.pollFirst() ?: return@post
            arm.inflight = op

            try {
                tx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeCharacteristic(
                        tx, op.bytes, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    tx.value = op.bytes
                    @Suppress("DEPRECATION")
                    gatt.writeCharacteristic(tx)
                }
            } catch (se: SecurityException) {
                val outcome = AckOutcome.WriteFailed("no BT permission")
                arm.inflight = null
                op.onResult?.invoke(outcome)
                return@post
            } catch (t: Throwable) {
                arm.inflight = null
                op.onResult?.invoke(AckOutcome.WriteFailed(t.message ?: "write error"))
                return@post
            }

            if (op.expectAckOpcode == null) {
                // Fire-and-forget: release slot after the 5ms inter-packet delay.
                arm.inflight = null
                worker.postDelayed({ pump(arm) }, INTER_PACKET_DELAY_MS)
            } else {
                // Ack-waiting: schedule timeout.
                worker.postDelayed({
                    val still = arm.inflight
                    if (still === op) {
                        arm.inflight = null
                        op.onResult?.invoke(AckOutcome.Timeout)
                        pump(arm)
                    }
                }, op.ackTimeoutMs)
            }
        }
    }

    // --- Notification dispatch ---------------------------------------------

    private fun handleNotification(arm: Arm, data: ByteArray) {
        if (data.isEmpty()) return
        val op0 = data[0]

        // Classify up front for the raw-frame subscriber (research logging).
        // "ack" check uses the live inflight op — safe on the worker thread.
        val inflightOp = arm.inflight
        val kind = when {
            op0 == G1Protocol.OP_AUDIO_FRAME -> "audio"
            op0 == G1Protocol.OP_TOUCHBAR -> "touch"
            op0 == G1Protocol.OP_HEARTBEAT -> "heartbeat"
            op0 == G1Protocol.OP_BATTERY -> "battery"
            op0 == G1Protocol.OP_WEAR_DETECT -> "wear"
            inflightOp != null && inflightOp.expectAckOpcode == op0 -> "ack"
            else -> "unhandled"
        }
        for (l in listeners) {
            try { l.onFrame(arm.side, data, kind) } catch (_: Throwable) {}
        }

        // Audio frames don't interact with the ack queue.
        if (op0 == G1Protocol.OP_AUDIO_FRAME) {
            G1Protocol.parseAudioFrame(data)?.let { (seq, lc3) ->
                for (l in listeners) l.onAudioFrame(seq, lc3)
            }
            return
        }

        // Touchbar events are pushed, not replies.
        if (op0 == G1Protocol.OP_TOUCHBAR) {
            G1Protocol.parseTouchEvent(data)?.let { sub ->
                // A few 0xF5 subcmds carry a single payload byte at data[2]
                // (charging-case state). Intercept those before forwarding
                // to listeners so GlassesState tracks the latest value.
                if (data.size >= 3) when (sub) {
                    G1Protocol.TOUCH_CASE_BATTERY -> {
                        val pct = data[2].toInt() and 0xFF
                        if (pct in 0..100) GlassesState.setCaseBattery(pct)
                    }
                    G1Protocol.TOUCH_CASE_CHARGING -> {
                        GlassesState.setCaseCharging(data[2] != 0.toByte())
                    }
                }
                for (l in listeners) l.onTouch(arm.side, sub)
            }
            return
        }

        // Heartbeat echoes: consume silently.
        if (op0 == G1Protocol.OP_HEARTBEAT) return

        // Battery poll reply (0x2C). Per-arm value; populates GlassesState.
        // Fire-and-forget — we don't serialize the poll through the ack queue
        // because MentraOS's reference doesn't either and it would stall
        // other writes if a reply is lost.
        if (op0 == G1Protocol.OP_BATTERY) {
            G1Protocol.parseBatteryReply(data)?.let { pct ->
                GlassesState.setBattery(arm.side, pct)
            }
            return
        }

        // Unsolicited wear-detection event (0x27). Fires on both arms;
        // idempotent setter means duplicate reports are cheap.
        if (op0 == G1Protocol.OP_WEAR_DETECT) {
            G1Protocol.parseWearEvent(data)?.let { worn ->
                GlassesState.setWorn(worn)
            }
            return
        }

        // Ack matching for whatever is in-flight.
        val op = arm.inflight
        if (op != null && op.expectAckOpcode == op0) {
            arm.inflight = null
            val parsed = G1Protocol.parseAck(op0, data)
            val outcome = when {
                parsed == null -> AckOutcome.Fail(data)
                parsed.ok -> AckOutcome.Ok(data)
                else -> AckOutcome.Fail(data)
            }
            op.onResult?.invoke(outcome)
            // After a 5ms cool-down, move on.
            worker.postDelayed({ pump(arm) }, INTER_PACKET_DELAY_MS)
            return
        }

        for (l in listeners) l.onUnhandled(arm.side, data)
    }

    // --- GATT callbacks -----------------------------------------------------

    private fun gattCallback(arm: Arm) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    GlassesState.setArmStatus(arm.side, GlassesState.ArmStatus.CONNECTING, gatt.device.address)
                    // Request a large MTU before service discovery. G1 text / BMP
                    // chunks are ~200 bytes; default ATT_MTU=23 would silently
                    // truncate every write. We proceed to service discovery
                    // either way (onMtuChanged on success, here on failure).
                    val mtuRequested = try {
                        gatt.requestMtu(MTU_REQUEST)
                    } catch (_: SecurityException) { false }
                    if (!mtuRequested) {
                        try { gatt.discoverServices() } catch (_: SecurityException) {}
                    }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    try { gatt.close() } catch (_: Exception) {}
                    arm.gatt = null
                    arm.tx = null
                    arm.rx = null
                    arm.inflight = null
                    arm.queue.clear()
                    GlassesState.setArmStatus(arm.side, GlassesState.ArmStatus.DISCONNECTED)
                    notifyStateChange()
                    scheduleReconnect(arm)
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            // Whether the upgrade succeeded or not, we now proceed to service
            // discovery. If it failed we'll still try — some stacks just ignore
            // the request and fall back to 23, in which case writes over 20
            // bytes will fail and surface via our existing timeout path.
            try { gatt.discoverServices() } catch (_: SecurityException) {}
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return
            val svc = gatt.getService(UUID.fromString(G1Protocol.NUS_SERVICE)) ?: run {
                GlassesState.setError("${arm.side} NUS service missing")
                return
            }
            arm.tx = svc.getCharacteristic(UUID.fromString(G1Protocol.NUS_TX_WRITE))
            arm.rx = svc.getCharacteristic(UUID.fromString(G1Protocol.NUS_RX_NOTIFY))
            val rx = arm.rx ?: return
            try {
                gatt.setCharacteristicNotification(rx, true)
                val descriptor = rx.getDescriptor(UUID.fromString(G1Protocol.CCCD))
                if (descriptor != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    } else {
                        @Suppress("DEPRECATION")
                        descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(descriptor)
                    }
                }
            } catch (_: SecurityException) {}
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            // Notifications enabled — we're now operationally connected.
            arm.reconnectDelayMs = RECONNECT_MIN_MS
            GlassesState.setArmStatus(arm.side, GlassesState.ArmStatus.CONNECTED, gatt.device.address)
            // Clear any stale error banner once we've got a working link.
            // Keeps the "Bluetooth is off" / "connect error" message from
            // lingering on the settings screen after a successful recovery.
            GlassesState.setError(null)
            notifyStateChange()
            // Android-specific post-connect init. Without this, the glasses
            // sit on "Loading" and ignore text/bmp/notify frames — BLE acks
            // writes but nothing renders. iOS uses 0x4D instead of 0xF4.
            enqueueOp(arm, WriteOp(G1Protocol.encodeInitAndroid()))
            // Kick off a battery poll right away so the UI doesn't sit on
            // `battery: null` for the first 80s. Reply lands in handleNotification.
            enqueueOp(arm, WriteOp(G1Protocol.encodeBatteryQuery()))
            // Kick the heartbeat once both sides are up; cheap to call repeatedly.
            startHeartbeat()
            // Pump any queued writes that came in before CCCD finished.
            pump(arm)
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION") val data = characteristic.value ?: return
            handleNotification(arm, data.copyOf())
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            handleNotification(arm, value.copyOf())
        }
    }

    private fun notifyStateChange() {
        for (l in listeners) l.onStateChange()
    }

    // --- Connect / disconnect ----------------------------------------------

    fun connectMac(mac: String?, side: G1Protocol.Arm) {
        if (mac.isNullOrEmpty()) return
        if (!hasBtConnect()) {
            GlassesState.setError("BLUETOOTH_CONNECT not granted")
            return
        }
        worker.post {
            val arm = if (side == G1Protocol.Arm.LEFT) left else right
            if (arm.gatt != null) return@post // already connecting/connected
            // Don't enter CONNECTING if the radio is off — `connectGatt`
            // would otherwise return a stub that never calls back, leaving
            // the UI permanently spinning. The BT state receiver will kick
            // us back into auto-reconnect when the user turns it on.
            val ad = adapter
            if (ad == null || !ad.isEnabled) {
                GlassesState.setError("Bluetooth is off")
                GlassesState.setArmStatus(side, GlassesState.ArmStatus.DISCONNECTED)
                return@post
            }
            try {
                val dev = ad.getRemoteDevice(mac) ?: run {
                    GlassesState.setError("no adapter")
                    return@post
                }
                GlassesState.setArmStatus(side, GlassesState.ArmStatus.CONNECTING, mac)
                arm.gatt = dev.connectGatt(app, false, gattCallback(arm), BluetoothDevice.TRANSPORT_LE)
            } catch (t: Throwable) {
                GlassesState.setError(t.message ?: "connect error")
                GlassesState.setArmStatus(side, GlassesState.ArmStatus.DISCONNECTED)
            }
        }
    }

    fun disconnect() {
        worker.post {
            stopHeartbeat()
            disconnectInternal(left)
            disconnectInternal(right)
        }
    }

    private fun disconnectInternal(arm: Arm) {
        try { arm.gatt?.disconnect() } catch (_: Exception) {}
        try { arm.gatt?.close() } catch (_: Exception) {}
        arm.gatt = null
        arm.tx = null
        arm.rx = null
        arm.queue.clear()
        arm.inflight = null
        arm.reconnectPending = false
        GlassesState.setArmStatus(arm.side, GlassesState.ArmStatus.DISCONNECTED)
        notifyStateChange()
    }

    private fun scheduleReconnect(arm: Arm) {
        if (!started || arm.reconnectPending) return
        val pair = PairStore(app).load() ?: return
        val mac = if (arm.side == G1Protocol.Arm.LEFT) pair.leftMac else pair.rightMac
        arm.reconnectPending = true
        worker.postDelayed({
            arm.reconnectPending = false
            connectMac(mac, arm.side)
        }, arm.reconnectDelayMs)
        arm.reconnectDelayMs = (arm.reconnectDelayMs * 2).coerceAtMost(RECONNECT_MAX_MS)
    }

    // --- Heartbeat ----------------------------------------------------------

    private fun startHeartbeat() {
        if (heartbeatRunnable != null) return
        val r = object : Runnable {
            override fun run() {
                if (!started) return
                if (left.gatt != null) {
                    val pkt = G1Protocol.encodeHeartbeat(left.heartbeatSeq++)
                    enqueueOp(left, WriteOp(pkt))
                }
                if (right.gatt != null) {
                    val pkt = G1Protocol.encodeHeartbeat(right.heartbeatSeq++)
                    enqueueOp(right, WriteOp(pkt))
                }
                // Poll battery every BATTERY_POLL_EVERY_N_HEARTBEATS ticks.
                // MentraOS uses the same 10× heartbeat cadence (~80s).
                heartbeatTickCount++
                if (heartbeatTickCount % BATTERY_POLL_EVERY_N_HEARTBEATS == 0) {
                    val q = G1Protocol.encodeBatteryQuery()
                    if (left.gatt != null) enqueueOp(left, WriteOp(q))
                    if (right.gatt != null) enqueueOp(right, WriteOp(q))
                }
                worker.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
        heartbeatRunnable = r
        worker.postDelayed(r, HEARTBEAT_INTERVAL_MS)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { worker.removeCallbacks(it) }
        heartbeatRunnable = null
        heartbeatTickCount = 0
    }

    // --- Scan ---------------------------------------------------------------

    @Volatile private var scanning = false
    private val scanMap = mutableMapOf<String, GlassesState.ScanCandidate>()
    private var scanCallbackRef: ScanCallback? = null

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = try { result.device.name } catch (_: SecurityException) { null }
            val mac = result.device.address
            val rssi = result.rssi
            // Diagnostic: surface *every* named advertisement so the user/hub
            // can see what's actually in range. G1 devices advertise as
            // e.g. "G1_45_L_92333"; if the regex in parseDeviceName is wrong
            // or the glasses use a different naming convention, this log
            // reveals it.
            if (!name.isNullOrEmpty()) {
                for (l in listeners) {
                    try { l.onScanObservation(name, mac, rssi) } catch (_: Throwable) {}
                }
            }
            val parsed = G1Protocol.parseDeviceName(name) ?: return
            val existing = scanMap[parsed.channel]
            val updated = when (parsed.arm) {
                G1Protocol.Arm.LEFT -> GlassesState.ScanCandidate(parsed.channel, mac, existing?.rightMac, rssi)
                G1Protocol.Arm.RIGHT -> GlassesState.ScanCandidate(parsed.channel, existing?.leftMac, mac, rssi)
            }
            scanMap[parsed.channel] = updated
            GlassesState.replaceScanCandidates(scanMap.toMap())
        }

        override fun onScanFailed(errorCode: Int) {
            val reason = when (errorCode) {
                SCAN_FAILED_ALREADY_STARTED -> "already started"
                SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "app registration failed"
                SCAN_FAILED_FEATURE_UNSUPPORTED -> "feature unsupported"
                SCAN_FAILED_INTERNAL_ERROR -> "internal error"
                else -> "code $errorCode"
            }
            GlassesState.setError("scan failed: $reason")
            scanning = false
            for (l in listeners) { try { l.onError("scan failed: $reason") } catch (_: Throwable) {} }
        }
    }

    fun startScan(durationMs: Long = 15_000L) {
        if (!hasBtScan()) {
            GlassesState.setError("BLUETOOTH_SCAN not granted")
            return
        }
        worker.post {
            if (scanning) return@post
            val scanner = adapter?.bluetoothLeScanner ?: run {
                GlassesState.setError("no LE scanner (bluetooth off?)")
                return@post
            }
            scanMap.clear()
            GlassesState.replaceScanCandidates(emptyMap())
            scanCallbackRef = scanCallback
            try {
                scanner.startScan(scanCallback)
                scanning = true
                worker.postDelayed({ stopScan() }, durationMs)
            } catch (t: Throwable) {
                GlassesState.setError(t.message ?: "scan error")
            }
        }
    }

    fun stopScan() {
        worker.post {
            if (!scanning) return@post
            scanning = false
            try { adapter?.bluetoothLeScanner?.stopScan(scanCallbackRef ?: scanCallback) }
            catch (_: Throwable) {}
            scanCallbackRef = null
        }
    }

    // --- Pair persistence ---------------------------------------------------

    fun pairAndConnect(leftMac: String, rightMac: String, channel: String) {
        val store = PairStore(app)
        store.save(PairStore.Pair(leftMac, rightMac, channel, System.currentTimeMillis()))
        GlassesState.setPair(leftMac, rightMac, channel)
        stop()
        started = true
        connectMac(leftMac, G1Protocol.Arm.LEFT)
        connectMac(rightMac, G1Protocol.Arm.RIGHT)
    }

    fun unpair() {
        PairStore(app).clear()
        worker.post {
            disconnectInternal(left)
            disconnectInternal(right)
            GlassesState.clearPair()
        }
    }

    // --- Permission helpers -------------------------------------------------

    private fun hasBtConnect(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            app, Manifest.permission.BLUETOOTH_CONNECT,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasBtScan(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            app, Manifest.permission.BLUETOOTH_SCAN,
        ) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val TAG = "GlassesBLE"
        private const val INTER_PACKET_DELAY_MS = 5L
        // ATT MTU requested right after GATT connect. BLE 4.2+ caps at 247 so
        // asking for that gets us the max on every compatible phone; lower
        // stacks negotiate down. Required because G1 text chunks are ~200 bytes.
        private const val MTU_REQUEST = 247
        private const val HEARTBEAT_INTERVAL_MS = 8_000L
        /** 10 × 8s = ~80s between battery polls, matching MentraOS. */
        private const val BATTERY_POLL_EVERY_N_HEARTBEATS = 10
        private const val RECONNECT_MIN_MS = 2_000L
        private const val RECONNECT_MAX_MS = 60_000L
        private const val DEFAULT_ACK_TIMEOUT_MS = 3_000L
    }
}
