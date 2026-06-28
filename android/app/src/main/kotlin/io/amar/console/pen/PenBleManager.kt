package io.amar.console.pen

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
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * Single-device GATT orchestrator for a NeoLAB Neo smartpen (NWP-F130, ProtocolV2).
 * Mirrors glasses/BleManager.kt but single-peripheral. The pen is bonded to the
 * phone, so we connect by MAC (from a scan or the bonded list).
 *
 * READ-ONLY for now: it establishes (REQ_PenInfo → REQ_PenStatus), authenticates
 * if needed, and streams every inbound frame to the research log via onFrame.
 * It contains NO offline-request / remove / disk-reset path — those land in Phase 2
 * with the keep-flag hard-forced, so this build cannot erase the pen.
 */
@SuppressLint("MissingPermission")
class PenBleManager(private val app: Context) {

    interface Listener {
        /** Every complete application frame (unescaped body), classified. For research log. */
        fun onFrame(body: ByteArray, kind: String) {}
        /** Bytes that arrived but didn't form a complete frame (partial/garbage) — never silently dropped. */
        fun onRaw(data: ByteArray) {}
        fun onStateChange() {}
        fun onError(msg: String) {}
        fun onScanObservation(name: String, mac: String, rssi: Int, has19f1: Boolean) {}
        fun onOfflineNotes(notes: List<PenProtocol.OfflineNote>) {}
        fun onOfflinePages(pages: PenProtocol.OfflinePages) {}
        fun onOfflineXferStart(section: Int, owner: Int, note: Long, page: Long, header: PenProtocol.OfflineHeader) {}
        fun onOfflineChunk(section: Int, owner: Int, note: Long, page: Long, packetId: Int, position: Int, raw: ByteArray) {}
        fun onOfflineDone(section: Int, owner: Int, note: Long, page: Long) {}
    }

    private val listeners = java.util.concurrent.CopyOnWriteArrayList<Listener>()
    fun addListener(l: Listener) { listeners.add(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }

    private val workerThread = HandlerThread("pen-ble").apply { start() }
    private val worker = Handler(workerThread.looper)

    private var gatt: BluetoothGatt? = null
    private var tx: BluetoothGattCharacteristic? = null
    private var rx: BluetoothGattCharacteristic? = null
    private val parser = PenProtocol.Parser()
    private val queue = ConcurrentLinkedDeque<ByteArray>()
    @Volatile private var inflight: ByteArray? = null
    private var reconnectDelayMs = RECONNECT_MIN_MS
    private var reconnectPending = false
    @Volatile private var wasConnected = false
    // current offline-pull target (set by pullPage; read when chunks arrive)
    @Volatile private var curSec = 0
    @Volatile private var curOwn = 0
    @Volatile private var curNote = 0L
    @Volatile private var curPage = 0L
    @Volatile private var pendingPassword: String? = null
    @Volatile private var triedAutoUnlock = false

    private val btManager: BluetoothManager? by lazy {
        app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    }
    private val adapter: BluetoothAdapter? get() = btManager?.adapter

    @Volatile private var started = false
    @Volatile private var btReceiverRegistered = false

    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_OFF, BluetoothAdapter.STATE_TURNING_OFF -> worker.post { onBluetoothDisabled() }
                BluetoothAdapter.STATE_ON -> worker.post { onBluetoothEnabled() }
            }
        }
    }

    fun start() {
        if (started) return
        started = true
        // v34: drop any previously-stored (unconfirmed) password. Passwords are now
        // sent ONLY on an explicit unlock — never auto-retried on reconnect.
        try { PairStore(app).clearPassword() } catch (_: Throwable) {}
        registerBtReceiver()
        worker.post {
            if (adapter?.isEnabled != true) PenState.setError("Bluetooth is off")
            // No boot-time auto-connect: the pen advertises only while awake and is
            // chosen explicitly via scan→connect. Auto-reconnect (scheduleReconnect)
            // only fires after a link that was actually established.
        }
    }

    fun stop() {
        started = false
        unregisterBtReceiver()
        worker.post { disconnectInternal(); stopScan() }
    }

    private fun registerBtReceiver() {
        if (btReceiverRegistered) return
        try {
            app.registerReceiver(bluetoothStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))
            btReceiverRegistered = true
        } catch (_: Throwable) {}
    }

    private fun unregisterBtReceiver() {
        if (!btReceiverRegistered) return
        try { app.unregisterReceiver(bluetoothStateReceiver) } catch (_: Throwable) {}
        btReceiverRegistered = false
    }

    private fun onBluetoothDisabled() {
        reconnectPending = false
        disconnectInternal()
        PenState.setError("Bluetooth is off")
    }

    private fun onBluetoothEnabled() {
        if (!started) return
        if (PenState.lastError == "Bluetooth is off") PenState.setError(null)
    }

    // --- public API ---------------------------------------------------------

    /** Connect to the pen. mac=null → use the saved pair, else the first bonded pen. */
    fun connect(mac: String?) {
        if (!hasBtConnect()) { PenState.setError("BLUETOOTH_CONNECT not granted"); return }
        worker.post {
            if (gatt != null) {
                if (PenState.status == PenState.Status.CONNECTED) return@post  // already linked
                disconnectInternal()  // override a stuck/previous attempt
            }
            wasConnected = false
            triedAutoUnlock = false
            pendingPassword = null
            val ad = adapter
            if (ad == null || !ad.isEnabled) {
                PenState.setError("Bluetooth is off"); PenState.setStatus(PenState.Status.DISCONNECTED); return@post
            }
            val target = mac ?: PairStore(app).load()?.mac ?: firstBondedPenMac()
            if (target == null) {
                PenState.setError("no pen paired — run `con pen scan` then `con pen connect <mac>`"); return@post
            }
            try {
                val dev = ad.getRemoteDevice(target)
                PenState.setStatus(PenState.Status.CONNECTING, target)
                parser.reset()
                gatt = dev.connectGatt(app, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } catch (t: Throwable) {
                PenState.setError(t.message ?: "connect error"); PenState.setStatus(PenState.Status.DISCONNECTED)
            }
        }
    }

    fun disconnect() { worker.post { wasConnected = false; reconnectPending = false; disconnectInternal() } }

    fun sendPassword(pw: String) {
        if (pw == "0000") { PenState.setError("0000 is the no-password sentinel; pen has a real password"); return }
        worker.post { pendingPassword = pw; enqueue(PenProtocol.buildPasswordInput(pw)) }
    }

    // --- offline data (read + keep only) ------------------------------------
    fun reqOfflineNotes() { worker.post { enqueue(PenProtocol.buildReqOfflineNoteListAll()) } }
    fun reqOfflinePages(section: Int, owner: Int, note: Long) {
        worker.post { enqueue(PenProtocol.buildReqOfflinePageList(section, owner, note)) }
    }
    /** Retrieve a single page, KEEP it on the pen (delete byte hard-wired to 2). */
    fun pullPage(section: Int, owner: Int, note: Long, page: Long) {
        worker.post {
            curSec = section; curOwn = owner; curNote = note; curPage = page
            enqueue(PenProtocol.buildPullPageKeep(section, owner, note, page))
        }
    }

    /** Debug: send an arbitrary cmd + payload, refusing destructive opcodes. */
    fun sendRaw(cmd: Int, data: ByteArray): Boolean {
        if (PenProtocol.isDestructive(cmd, data)) {
            PenState.setError("refused destructive raw cmd 0x%02X".format(cmd))
            return false
        }
        worker.post { enqueue(PenProtocol.encodeRequest(cmd, data)) }
        return true
    }

    /** Bonded BLE devices that look like a Neo pen (0x19F1 service, or NWP/Neo name). */
    fun listBondedPens(): JSONArray {
        val arr = JSONArray()
        val bonded = try { adapter?.bondedDevices } catch (_: SecurityException) { null } ?: return arr
        for (d in bonded) {
            val has19f1 = d.uuids?.any { it == SERVICE_PARCEL } == true
            val name = try { d.name } catch (_: SecurityException) { null }
            val looksPen = has19f1 || (name?.let { n -> PEN_NAME_HINTS.any { n.contains(it, ignoreCase = true) } } == true)
            if (looksPen) {
                arr.put(JSONObject().put("mac", d.address).put("name", name ?: JSONObject.NULL).put("has19f1", has19f1))
            }
        }
        return arr
    }

    private fun firstBondedPenMac(): String? {
        val bonded = try { adapter?.bondedDevices } catch (_: SecurityException) { null } ?: return null
        // Prefer a device advertising the 0x19F1 service; fall back to a name hint.
        bonded.firstOrNull { it.uuids?.any { u -> u == SERVICE_PARCEL } == true }?.let { return it.address }
        bonded.firstOrNull { d ->
            val n = try { d.name } catch (_: SecurityException) { null }
            n?.let { name -> PEN_NAME_HINTS.any { name.contains(it, ignoreCase = true) } } == true
        }?.let { return it.address }
        return null
    }

    // --- write queue --------------------------------------------------------

    private fun enqueue(bytes: ByteArray) { queue.addLast(bytes); pump() }

    private fun pump() {
        worker.post {
            if (inflight != null) return@post
            val g = gatt ?: return@post
            val t = tx ?: return@post
            if (PenState.status != PenState.Status.CONNECTED) return@post
            val op = queue.pollFirst() ?: return@post
            inflight = op
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    g.writeCharacteristic(t, op, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                } else {
                    @Suppress("DEPRECATION") run {
                        t.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        t.value = op
                        g.writeCharacteristic(t)
                    }
                }
            } catch (t2: Throwable) {
                inflight = null
                PenState.setError(t2.message ?: "write error")
                return@post
            }
            // Safety net: if onCharacteristicWrite never fires, don't stall forever.
            worker.postDelayed({
                if (inflight === op) { inflight = null; pump() }
            }, WRITE_TIMEOUT_MS)
        }
    }

    // --- GATT callbacks -----------------------------------------------------

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    PenState.setStatus(PenState.Status.CONNECTING, g.device.address)
                    val ok = try { g.requestMtu(MTU_REQUEST) } catch (_: SecurityException) { false }
                    if (!ok) try { g.discoverServices() } catch (_: SecurityException) {}
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    try { g.close() } catch (_: Exception) {}
                    gatt = null; tx = null; rx = null; inflight = null; queue.clear()
                    PenState.setStatus(PenState.Status.DISCONNECTED)
                    notifyStateChange()
                    scheduleReconnect()
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            try { g.discoverServices() } catch (_: SecurityException) {}
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) return
            // Dump the full GATT to the research log (kind="gatt") for protocol diagnosis.
            val sb = StringBuilder()
            for (s in g.services) {
                sb.append(s.uuid.toString()).append("{")
                for (c in s.characteristics) sb.append(c.uuid.toString()).append(":").append(c.properties).append(",")
                sb.append("} ")
            }
            for (l in listeners) { try { l.onFrame(sb.toString().toByteArray(Charsets.UTF_8), "gatt") } catch (_: Throwable) {} }
            // Resolve the Neo service: ProtocolV2 (0x19F1) or the newer V5 128-bit set.
            var svc = g.getService(SERVICE_UUID)
            var writeU = WRITE_UUID
            var notifyU = NOTIFY_UUID
            if (svc == null) { svc = g.getService(SERVICE_UUID_V5); writeU = WRITE_UUID_V5; notifyU = NOTIFY_UUID_V5 }
            if (svc == null) { PenState.setError("Neo service not found; gatt=" + sb.toString().take(180)); return }
            tx = svc.getCharacteristic(writeU)
            rx = svc.getCharacteristic(notifyU)
            val r = rx ?: run { PenState.setError("pen notify char missing"); return }
            try {
                g.setCharacteristicNotification(r, true)
                val cccd = r.getDescriptor(CCCD)
                // The pen's 0x2BA1 is set up as INDICATE when available (doc 2).
                val enable = if (r.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)
                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (cccd != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) g.writeDescriptor(cccd, enable)
                    else { @Suppress("DEPRECATION") run { cccd.value = enable; g.writeDescriptor(cccd) } }
                }
            } catch (_: SecurityException) {}
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            reconnectDelayMs = RECONNECT_MIN_MS
            wasConnected = true
            PenState.setStatus(PenState.Status.CONNECTED, g.device.address)
            PenState.setError(null)
            // Save for auto-reconnect only once we've actually established a link.
            try { PairStore(app).save(PairStore.Pair(g.device.address, g.device.name, System.currentTimeMillis())) } catch (_: Throwable) {}
            notifyStateChange()
            // Establish: REQ_PenInfo kicks the handshake (doc 5.1).
            enqueue(PenProtocol.buildReqPenInfo())
            pump()
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            inflight = null
            worker.postDelayed({ pump() }, INTER_PACKET_DELAY_MS)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION") val data = c.value ?: return
            onInbound(data.copyOf())
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            onInbound(value.copyOf())
        }
    }

    // --- inbound handling + handshake --------------------------------------

    private fun onInbound(data: ByteArray) {
        for (l in listeners) { try { l.onRaw(data) } catch (_: Throwable) {} }
        val frames = parser.feed(data)
        for (f in frames) {
            val kind = PenProtocol.kind(f.cmd)
            val body = if (f.body.isNotEmpty()) f.body else byteArrayOf(f.cmd.toByte())
            for (l in listeners) { try { l.onFrame(body, kind) } catch (_: Throwable) {} }
            handleFrame(f)
        }
    }

    private fun handleFrame(f: PenProtocol.Frame) {
        when (f.cmd) {
            PenProtocol.RES_PenInfo -> {
                if (f.ok) {
                    val info = PenProtocol.parsePenInfo(f)
                    PenState.setPenInfo(info.name, info.firmware)
                }
                // Next establish step regardless — request status (auth gate lives there).
                enqueue(PenProtocol.buildReqPenStatus())
            }
            PenProtocol.RES_PenStatus -> {
                if (f.ok) {
                    val s = PenProtocol.parsePenStatus(f)
                    PenState.setBattery(s.batteryPct)
                    PenState.setStorage(s.usedMemPct)
                    PenState.setOfflineSave(s.offlineSaveOn)
                    PenState.setLocked(s.isLock)
                    if (s.isLock && !PenState.authorized) {
                        // NO auto-retry — a password is sent ONLY on an explicit unlock,
                        // so a wrong stored password can never burn the pen's retry counter.
                        PenState.setError("pen is locked — unlock with a password to proceed")
                    } else if (!s.isLock) {
                        PenState.setAuthorized(true)
                        PenState.setError(null)
                        enqueue(PenProtocol.buildSetRtc(System.currentTimeMillis()))  // RTC enables offline
                    }
                }
            }
            PenProtocol.RES_Password -> {
                // The REAL auth signal is the inner status byte == 1 (both SDKs gate on it;
                // status==0 is a REJECTION). data layout: status(1), retryCount(1), resetCount(1).
                val st = if (f.data.isNotEmpty()) f.data[0].toInt() and 0xFF else -1
                val retry = if (f.data.size > 1) f.data[1].toInt() and 0xFF else -1
                val reset = if (f.data.size > 2) f.data[2].toInt() and 0xFF else -1
                pendingPassword = null
                if (f.ok && st == 1) {
                    PenState.setAuthorized(true)
                    PenState.setError(null)
                    enqueue(PenProtocol.buildSetRtc(System.currentTimeMillis()))  // RTC enables offline access
                    enqueue(PenProtocol.buildReqPenStatus())
                } else {
                    PenState.setAuthorized(false)
                    PenState.setError("password rejected (status=$st  retry=$retry  reset=$reset)")
                }
            }
            PenProtocol.EVT_Battery -> if (f.data.isNotEmpty()) PenState.setBattery(f.data[0].toInt() and 0xFF)
            PenProtocol.EVT_PowerOff -> PenState.setError("pen powered off")
            PenProtocol.EVT_Dot -> {
                val d = PenProtocol.parseDot(f)
                PenState.setLastDot(d.x, d.y)
            }
            PenProtocol.RES_OfflineNoteList -> if (f.ok) {
                val notes = PenProtocol.parseOfflineNoteList(f)
                for (l in listeners) try { l.onOfflineNotes(notes) } catch (_: Throwable) {}
            }
            PenProtocol.RES_OfflinePageList -> if (f.ok) {
                val p = PenProtocol.parseOfflinePageList(f)
                for (l in listeners) try { l.onOfflinePages(p) } catch (_: Throwable) {}
            }
            PenProtocol.RES_OfflineDataReq -> if (f.ok) {
                val h = PenProtocol.parseOfflineHeader(f)
                for (l in listeners) try { l.onOfflineXferStart(curSec, curOwn, curNote, curPage, h) } catch (_: Throwable) {}
            }
            PenProtocol.RES_OfflineChunk -> {
                val c = PenProtocol.parseOfflineChunk(f)
                // SAVE-BEFORE-ACK: hand the raw chunk to the hub first, then ack.
                for (l in listeners) try { l.onOfflineChunk(curSec, curOwn, curNote, curPage, c.packetId, c.position, f.data) } catch (_: Throwable) {}
                enqueue(PenProtocol.buildOfflineChunkAck(c.packetId, c.position))
                if (c.position == 2) for (l in listeners) try { l.onOfflineDone(curSec, curOwn, curNote, curPage) } catch (_: Throwable) {}
            }
        }
    }

    private fun notifyStateChange() { for (l in listeners) { try { l.onStateChange() } catch (_: Throwable) {} } }

    // --- connect / disconnect / reconnect ----------------------------------

    private fun disconnectInternal() {
        try { gatt?.disconnect() } catch (_: Exception) {}
        try { gatt?.close() } catch (_: Exception) {}
        gatt = null; tx = null; rx = null; queue.clear(); inflight = null; reconnectPending = false
        PenState.setStatus(PenState.Status.DISCONNECTED)
        notifyStateChange()
    }

    private fun scheduleReconnect() {
        if (!started || reconnectPending || !wasConnected) return
        val mac = PairStore(app).load()?.mac ?: return
        reconnectPending = true
        worker.postDelayed({ reconnectPending = false; connect(mac) }, reconnectDelayMs)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(RECONNECT_MAX_MS)
    }

    // --- scan ---------------------------------------------------------------

    @Volatile private var scanning = false
    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = try { result.device.name } catch (_: SecurityException) { null } ?: "(unnamed)"
            val has19f1 = result.scanRecord?.serviceUuids?.any { it == SERVICE_PARCEL } == true
            for (l in listeners) {
                try { l.onScanObservation(name, result.device.address, result.rssi, has19f1) } catch (_: Throwable) {}
            }
        }
        override fun onScanFailed(errorCode: Int) {
            scanning = false
            PenState.setError("scan failed: code $errorCode")
            for (l in listeners) { try { l.onError("scan failed: code $errorCode") } catch (_: Throwable) {} }
        }
    }

    fun startScan(durationMs: Long = 15_000L) {
        if (!hasBtScan()) { PenState.setError("BLUETOOTH_SCAN not granted"); return }
        worker.post {
            if (scanning) return@post
            val scanner = adapter?.bluetoothLeScanner ?: run { PenState.setError("no LE scanner (bluetooth off?)"); return@post }
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            try {
                // No service filter — the pen sometimes omits 0x19F1 from its advert.
                // Report everything and flag which entries carry the pen service.
                scanner.startScan(null, settings, scanCallback)
                scanning = true
                worker.postDelayed({ stopScan() }, durationMs)
            } catch (t: Throwable) { PenState.setError(t.message ?: "scan error") }
        }
    }

    fun stopScan() {
        worker.post {
            if (!scanning) return@post
            scanning = false
            try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Throwable) {}
        }
    }

    // --- permissions --------------------------------------------------------

    private fun hasBtConnect(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(app, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasBtScan(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(app, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        // ProtocolV2 GATT (docs/neo-pen-protocol.md §2; BTLEAdt.java:148-150)
        val SERVICE_UUID: UUID = UUID.fromString("000019f1-0000-1000-8000-00805f9b34fb")
        val WRITE_UUID: UUID = UUID.fromString("00002ba0-0000-1000-8000-00805f9b34fb")
        val NOTIFY_UUID: UUID = UUID.fromString("00002ba1-0000-1000-8000-00805f9b34fb")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        val SERVICE_PARCEL = ParcelUuid(SERVICE_UUID)
        // Newer NeoLAB pens (the "Smart Pen") use a 128-bit "V5" UUID set (BTLEAdt.java:152-154).
        val SERVICE_UUID_V5: UUID = UUID.fromString("4f99f138-9d53-5bfa-9e50-b147491afe68")
        val WRITE_UUID_V5: UUID = UUID.fromString("8bc8cc7d-88ca-56b0-af9a-9bf514d0d61a")
        val NOTIFY_UUID_V5: UUID = UUID.fromString("64cd86b1-2256-5aeb-9f04-2caf6c60ae57")

        private val PEN_NAME_HINTS = listOf("NWP", "Neo", "Moleskine", "smartpen", "Pen")

        private const val MTU_REQUEST = 512
        private const val INTER_PACKET_DELAY_MS = 5L
        private const val WRITE_TIMEOUT_MS = 2_000L
        private const val RECONNECT_MIN_MS = 2_000L
        private const val RECONNECT_MAX_MS = 60_000L
    }
}
