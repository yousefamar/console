package io.amar.console.glasses

import java.util.zip.CRC32

/**
 * Pure protocol layer for G1 smart glasses — no BLE, no Android, no state.
 * Every function here is a byte-slinger. Unit-testable in isolation.
 *
 * See `docs/g1-protocol.md` for the full wire-format reference.
 */
object G1Protocol {

    // --- Service / characteristic UUIDs (Nordic UART Service) ---------------

    const val NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
    const val NUS_TX_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
    const val NUS_RX_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
    const val CCCD = "00002902-0000-1000-8000-00805f9b34fb"

    // --- Opcodes ------------------------------------------------------------

    const val OP_APP_WHITELIST: Byte = 0x04
    const val OP_HEADUP_ANGLE: Byte = 0x0B
    const val OP_MIC_CONTROL: Byte = 0x0E
    /**
     * Post-connect init handshake. Android uses `[0xF4, 0x01]`; iOS uses
     * `[0x4D, 0x01]`. Without it the glasses stay on the "Loading" screen and
     * ignore text/notify/bmp commands (BLE still acks writes, but nothing
     * renders). Discovered via the `g1-term` reverse-engineering notes.
     */
    const val OP_INIT_ANDROID: Byte = 0xF4.toByte()
    const val OP_BMP_DATA: Byte = 0x15
    const val OP_BMP_CRC: Byte = 0x16
    const val OP_EXIT: Byte = 0x18
    const val OP_BMP_END: Byte = 0x20
    const val OP_HEARTBEAT: Byte = 0x25
    const val OP_WEAR_DETECT: Byte = 0x27
    const val OP_BATTERY: Byte = 0x2C
    const val OP_SERIAL_NUMBER: Byte = 0x34
    /**
     * Unsolicited "QuickNote database snapshot" frame. Fires on long-press of
     * the right temple (default touchbar mapping) after the user records a
     * voice note. Wire format (empirically, not in any public reference):
     *   byte[0] = 0x21
     *   byte[1] = total frame length (incl. header)
     *   byte[2] = reserved (always 0x00 so far)
     *   byte[3] = monotonically-increasing request sequence
     *   byte[4] = reserved (0x01)
     *   byte[5] = saved-note count
     *   byte[6..] = variable-length metadata records (8-byte blocks, exact
     *               structure TBD — each contains the `61 92 65` channel-id
     *               signature + a timestamp-like prefix).
     * We classify but don't yet parse the payload.
     */
    const val OP_QUICKNOTE_SNAPSHOT: Byte = 0x21
    const val OP_NOTIFICATION: Byte = 0x4B
    const val OP_TEXT: Byte = 0x4E
    const val OP_AUDIO_FRAME: Byte = 0xF1.toByte()
    const val OP_TOUCHBAR: Byte = 0xF5.toByte()

    // Result codes (second-to-last-ish byte after command echo)
    const val RESULT_OK: Byte = 0xC9.toByte()
    const val RESULT_FAIL: Byte = 0xCA.toByte()

    // Text screen-status nibbles (byte 4 of a 0x4E packet)
    const val SCREEN_TEXT_NEW: Byte = 0x71 // plain text + new content

    // Touchbar subcommands (byte 1 of an inbound 0xF5 packet)
    const val TOUCH_DOUBLE_TAP_EXIT: Byte = 0x00
    const val TOUCH_SINGLE_TAP: Byte = 0x01
    const val TOUCH_TRIPLE_TAP_A: Byte = 0x04
    const val TOUCH_TRIPLE_TAP_B: Byte = 0x05
    const val TOUCH_LONG_PRESS_START: Byte = 0x17
    const val TOUCH_LONG_PRESS_RELEASE: Byte = 0x18

    // 0xF5 subcmds for charging-case state (see docs/g1-protocol.md §8b)
    const val TOUCH_CASE_REMOVED_A: Byte = 0x06
    const val TOUCH_CASE_REMOVED_B: Byte = 0x07
    const val TOUCH_CASE_OPENED: Byte = 0x08
    const val TOUCH_ARM_DOCKED: Byte = 0x09      // byte[2] = 1 on charging pin, 0 off
    const val TOUCH_BATTERY_PUSH: Byte = 0x0A    // byte[2] = arm battery pct 0-100 (unsolicited)
    const val TOUCH_CASE_CLOSED: Byte = 0x0B
    const val TOUCH_CASE_CHARGING: Byte = 0x0E   // byte[2] = 0/1
    const val TOUCH_CASE_BATTERY: Byte = 0x0F    // byte[2] = pct 0-100

    // --- Chunk size limits --------------------------------------------------

    const val TEXT_CHUNK_BODY = 191   // UTF-8 bytes per 0x4E chunk
    const val BMP_CHUNK_BODY = 194    // raw BMP bytes per 0x15 chunk
    const val NOTIFICATION_CHUNK_BODY = 176

    // --- BMP upload constants ----------------------------------------------

    /** Fixed flash target address prepended to the first BMP packet AND included in CRC input. */
    val BMP_FLASH_ADDRESS: ByteArray = byteArrayOf(0x00, 0x1C, 0x00, 0x00)

    /** Canonical end-of-stream marker sent after all 0x15 packets. */
    val BMP_END_PACKET: ByteArray = byteArrayOf(OP_BMP_END, 0x0D, 0x0E)

    // --- Arm side -----------------------------------------------------------

    enum class Arm { LEFT, RIGHT }

    /**
     * Match a G1 advertisement name and return {arm, channel}. The "channel
     * number" (middle token) identifies the pair — both arms share it.
     *
     * Real G1 firmware advertises as e.g. `"Even G1_92_R_205E26"`:
     *   - optional `"Even "` prefix (the physical glasses; EvenDemoApp
     *     sometimes shows the trimmed form too)
     *   - `G1` model token (accept any `G\d+` for forward-compat)
     *   - channel number (decimal) — this is the `_92_` token
     *   - `L` or `R` arm side
     *   - device-specific hex suffix (NOT decimal — the original
     *     `_\d+$` regex silently rejected every real advertisement we saw
     *     during the 2026-04 scan diagnostic pass)
     */
    data class ParsedName(val arm: Arm, val channel: String)

    private val deviceNameRegex = Regex("^(?:Even )?G\\d+_(\\d+)_([LR])_[0-9A-Fa-f]+$")

    fun parseDeviceName(name: String?): ParsedName? {
        if (name.isNullOrEmpty()) return null
        val m = deviceNameRegex.matchEntire(name) ?: return null
        val channel = m.groupValues[1]
        val arm = when (m.groupValues[2]) {
            "L" -> Arm.LEFT
            "R" -> Arm.RIGHT
            else -> return null
        }
        return ParsedName(arm, channel)
    }

    // --- Heartbeat ----------------------------------------------------------

    /** `[0x25, 0x06, 0x00, seq, 0x04, seq]` — 6 bytes total, seq wraps mod 256. */
    fun encodeHeartbeat(seq: Int): ByteArray {
        val s = (seq and 0xFF).toByte()
        return byteArrayOf(OP_HEARTBEAT, 0x06, 0x00, s, 0x04, s)
    }

    // --- Text (0x4E) --------------------------------------------------------

    /**
     * Encode a single text chunk. Caller is responsible for chunking.
     *
     * @param syncSeq  per-message increment (wraps mod 256). Reuse for all
     *                 chunks of the same message; change for the next message.
     * @param chunkIdx 0-indexed index of this chunk.
     * @param totalChunks total number of chunks (>= 1). Goes on the wire as
     *                 byte[2] verbatim — the protocol expects a count, not
     *                 a max-index.
     * @param textBytes UTF-8 bytes, <= TEXT_CHUNK_BODY.
     */
    fun encodeTextChunk(
        syncSeq: Int,
        chunkIdx: Int,
        totalChunks: Int,
        textBytes: ByteArray,
        screenStatus: Byte = SCREEN_TEXT_NEW,
        currentPage: Int = 1,
        maxPage: Int = 1,
    ): ByteArray {
        require(textBytes.size <= TEXT_CHUNK_BODY) {
            "text chunk body ${textBytes.size} > $TEXT_CHUNK_BODY"
        }
        require(chunkIdx in 0 until totalChunks)
        val out = ByteArray(9 + textBytes.size)
        out[0] = OP_TEXT
        out[1] = (syncSeq and 0xFF).toByte()
        // Per api.md and g1-term: byte[2] is total_packages (count), NOT
        // max-index. A 1-chunk message sends total=1, current=0. Earlier
        // versions sent `totalChunks - 1` here — firmware acked 0xCB but
        // rendered nothing because total=0 means "no chunks to display".
        out[2] = (totalChunks and 0xFF).toByte()
        out[3] = (chunkIdx and 0xFF).toByte()
        out[4] = screenStatus
        out[5] = 0x00 // pos hi
        out[6] = 0x00 // pos lo
        out[7] = (currentPage and 0xFF).toByte()
        out[8] = (maxPage and 0xFF).toByte()
        System.arraycopy(textBytes, 0, out, 9, textBytes.size)
        return out
    }

    /**
     * Split a full text string into TEXT_CHUNK_BODY-sized UTF-8 chunks
     * without breaking multi-byte code points.
     */
    fun chunkText(text: String, max: Int = TEXT_CHUNK_BODY): List<ByteArray> {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) return listOf(ByteArray(0))
        val chunks = mutableListOf<ByteArray>()
        var i = 0
        while (i < bytes.size) {
            var end = minOf(i + max, bytes.size)
            // Back up if we'd split inside a UTF-8 code point.
            if (end < bytes.size) {
                while (end > i && (bytes[end].toInt() and 0xC0) == 0x80) end--
                // Safety: if backing up collapsed the window (shouldn't happen
                // for well-formed UTF-8 with max >= 4), fall back to hard cut.
                if (end == i) end = minOf(i + max, bytes.size)
            }
            chunks.add(bytes.copyOfRange(i, end))
            i = end
        }
        return chunks
    }

    /**
     * The display panel shows 5 lines at a time. Short content silently falls
     * above the visible viewport — it's there but you can't see it. The
     * EvenDemoApp padding convention is to keep at most 5 lines (tailing) and
     * pad with leading blanks so the content is bottom-aligned.
     */
    fun padTextToFiveLines(text: String): String {
        val lines = text.split('\n').takeLast(5).toMutableList()
        while (lines.size < 5) lines.add(0, "")
        return lines.joinToString("\n")
    }

    /** One-shot helper: text → list of fully-encoded 0x4E packets. */
    fun encodeText(text: String, syncSeq: Int): List<ByteArray> {
        val padded = padTextToFiveLines(text)
        val bodies = chunkText(padded)
        return bodies.mapIndexed { idx, body ->
            encodeTextChunk(syncSeq, idx, bodies.size, body)
        }
    }

    // --- BMP upload (0x15 / 0x20 / 0x16) ------------------------------------

    /** Slice a BMP into 0x15 packets. First packet prefixes the flash address. */
    fun encodeBmpPackets(bmp: ByteArray): List<ByteArray> {
        require(bmp.isNotEmpty()) { "empty bmp" }
        val out = mutableListOf<ByteArray>()
        var i = 0
        var seq = 0
        while (i < bmp.size) {
            val bodyLen = minOf(BMP_CHUNK_BODY, bmp.size - i)
            val body = bmp.copyOfRange(i, i + bodyLen)
            val pkt: ByteArray = if (seq == 0) {
                // [0x15, 0, 0x00, 0x1C, 0x00, 0x00, ...194 body bytes]
                ByteArray(2 + BMP_FLASH_ADDRESS.size + body.size).also {
                    it[0] = OP_BMP_DATA
                    it[1] = 0
                    System.arraycopy(BMP_FLASH_ADDRESS, 0, it, 2, BMP_FLASH_ADDRESS.size)
                    System.arraycopy(body, 0, it, 2 + BMP_FLASH_ADDRESS.size, body.size)
                }
            } else {
                // [0x15, seq, ...body]
                ByteArray(2 + body.size).also {
                    it[0] = OP_BMP_DATA
                    it[1] = (seq and 0xFF).toByte()
                    System.arraycopy(body, 0, it, 2, body.size)
                }
            }
            out.add(pkt)
            i += bodyLen
            seq++
        }
        return out
    }

    /**
     * CRC32 (aka "CRC32/XZ" — same polynomial and init/xor as zip/ISO-HDLC)
     * over `BMP_FLASH_ADDRESS || bmp`, emitted **big-endian**.
     */
    fun bmpCrcPacket(bmp: ByteArray): ByteArray {
        val crc = CRC32().apply {
            update(BMP_FLASH_ADDRESS)
            update(bmp)
        }.value
        // `crc` is a long holding an unsigned 32-bit value. Big-endian: MSB first.
        return byteArrayOf(
            OP_BMP_CRC,
            ((crc ushr 24) and 0xFF).toByte(),
            ((crc ushr 16) and 0xFF).toByte(),
            ((crc ushr 8) and 0xFF).toByte(),
            (crc and 0xFF).toByte(),
        )
    }

    // --- Notification (0x4B) ------------------------------------------------

    /** Chunk a JSON notification payload into 0x4B packets. */
    fun encodeNotificationChunks(
        msgId: Int,
        json: String,
        max: Int = NOTIFICATION_CHUNK_BODY,
    ): List<ByteArray> {
        val bytes = json.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) return emptyList()
        val chunks = mutableListOf<ByteArray>()
        var i = 0
        val total = (bytes.size + max - 1) / max
        var seq = 0
        while (i < bytes.size) {
            val end = minOf(i + max, bytes.size)
            val body = bytes.copyOfRange(i, end)
            val pkt = ByteArray(4 + body.size)
            pkt[0] = OP_NOTIFICATION
            pkt[1] = (msgId and 0xFF).toByte()
            // Same count-vs-max-index pitfall as 0x4E: byte[2] is total count.
            pkt[2] = (total and 0xFF).toByte()
            pkt[3] = (seq and 0xFF).toByte()
            System.arraycopy(body, 0, pkt, 4, body.size)
            chunks.add(pkt)
            i = end
            seq++
        }
        return chunks
    }

    // --- App whitelist (0x04) ----------------------------------------------

    /**
     * Default app-whitelist JSON. The firmware silently DROPS `0x4B`
     * notification pushes for any `app_identifier` that isn't whitelisted, so
     * this must be sent once post-connect before notifications will render.
     *
     * We register a single Console app id ([NOTIFY_APP_ID]) and flip the
     * first-class flags (calendar/call/msg/mail) on for good measure. Every
     * Console notification rides the one id; the human-readable source goes in
     * the 0x4B `display_name` / `title`, so one whitelist entry is enough.
     *
     * Structure mirrors EvenDemoApp / docs/g1-protocol.md §14.
     */
    const val NOTIFY_APP_ID = "io.amar.console"
    const val NOTIFY_APP_NAME = "Console"

    fun defaultWhitelistJson(): String =
        """{"calendar_enable":true,"call_enable":true,"msg_enable":true,"ios_mail_enable":true,""" +
            """"app":{"list":[{"id":"$NOTIFY_APP_ID","name":"$NOTIFY_APP_NAME"}],"enable":true}}"""

    /**
     * Chunk an app-whitelist JSON payload into 0x04 packets. Header is
     * 3 bytes `[0x04, totalChunks, seq]` (no msgId, unlike 0x4B/0x4E).
     */
    fun encodeAppWhitelistChunks(
        json: String,
        max: Int = NOTIFICATION_CHUNK_BODY,
    ): List<ByteArray> {
        val bytes = json.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) return emptyList()
        val chunks = mutableListOf<ByteArray>()
        val total = (bytes.size + max - 1) / max
        var i = 0
        var seq = 0
        while (i < bytes.size) {
            val end = minOf(i + max, bytes.size)
            val body = bytes.copyOfRange(i, end)
            val pkt = ByteArray(3 + body.size)
            pkt[0] = OP_APP_WHITELIST
            pkt[1] = (total and 0xFF).toByte()
            pkt[2] = (seq and 0xFF).toByte()
            System.arraycopy(body, 0, pkt, 3, body.size)
            chunks.add(pkt)
            i = end
            seq++
        }
        return chunks
    }

    // --- Mic / exit / serial (single-byte or tiny) -------------------------

    fun encodeMic(enable: Boolean): ByteArray =
        byteArrayOf(OP_MIC_CONTROL, if (enable) 0x01 else 0x00)

    fun encodeExit(): ByteArray = byteArrayOf(OP_EXIT)

    /**
     * Configure the pitch threshold (degrees) at which a head-up tilt
     * triggers the dashboard. MentraOS `G1.java` `sendHeadUpAngleCommand`.
     * Angle is clamped to 0..60. Currently unwired — kept for parity.
     */
    fun encodeHeadUpAngle(angle: Int): ByteArray {
        val clamped = angle.coerceIn(0, 60)
        return byteArrayOf(OP_HEADUP_ANGLE, clamped.toByte())
    }

    /** Android-specific post-connect init handshake — see [OP_INIT_ANDROID]. */
    fun encodeInitAndroid(): ByteArray = byteArrayOf(OP_INIT_ANDROID, 0x01)

    fun encodeSerialQuery(): ByteArray = byteArrayOf(OP_SERIAL_NUMBER)

    // --- Response parsing ---------------------------------------------------

    data class Ack(val opcode: Byte, val ok: Boolean, val payload: ByteArray)

    /**
     * Lenient ack parser: searches the response for a 0xC9 / 0xCA byte.
     * Some firmware puts the result in byte[1], some in byte[5] (BMP),
     * some in the last byte. We don't try to be clever — any occurrence of
     * 0xC9 wins over 0xCA, and 0xCA wins only if no 0xC9 is present.
     */
    fun parseAck(expectedOpcode: Byte, data: ByteArray): Ack? {
        if (data.isEmpty() || data[0] != expectedOpcode) return null
        val ok = data.any { it == RESULT_OK }
        val fail = data.any { it == RESULT_FAIL }
        if (!ok && !fail) {
            // No explicit pass/fail; treat as a data response (0xC9 is the
            // canonical "ok", but e.g. 0x34 serial just echoes SN bytes).
            return Ack(expectedOpcode, true, data)
        }
        return Ack(expectedOpcode, ok || !fail, data)
    }

    /**
     * Parse a `[0xF1, seq, 200 bytes LC3]` frame.
     * Returns null if the frame isn't the expected 202-byte shape.
     */
    fun parseAudioFrame(data: ByteArray): Pair<Int, ByteArray>? {
        if (data.size != 202 || data[0] != OP_AUDIO_FRAME) return null
        val seq = data[1].toInt() and 0xFF
        return seq to data.copyOfRange(2, 202)
    }

    /** Parse an inbound 0xF5 touchbar event → subcmd byte, or null. */
    fun parseTouchEvent(data: ByteArray): Byte? {
        if (data.size < 2 || data[0] != OP_TOUCHBAR) return null
        return data[1]
    }

    /** Parse a 0x34 serial-number response. Returns the ASCII serial or null. */
    fun parseSerialNumber(data: ByteArray): String? {
        if (data.size < 18 || data[0] != OP_SERIAL_NUMBER) return null
        return String(data, 2, 16, Charsets.US_ASCII).trim { it <= ' ' }
    }

    // --- Battery (0x2C) -----------------------------------------------------

    /**
     * Poll query. Android firmware treats the second byte as a platform hint
     * (iOS uses 0x02). Per-arm: send to L and R independently.
     */
    fun encodeBatteryQuery(): ByteArray = byteArrayOf(OP_BATTERY, 0x01)

    /**
     * Parse a 0x2C reply. Wire format per MentraOS: `[0x2C, 0x66, pct, ...]`.
     * The 0x66 magic is required; firmware versions that don't match it emit
     * a different shape we don't yet understand.
     */
    fun parseBatteryReply(data: ByteArray): Int? {
        if (data.size < 3 || data[0] != OP_BATTERY) return null
        if (data[1] != 0x66.toByte()) return null
        val pct = data[2].toInt() and 0xFF
        return if (pct in 0..100) pct else null
    }

    // --- Wear detection (0x27) ----------------------------------------------

    /**
     * Parse an unsolicited 0x27 wear event. `true` = put on the head,
     * `false` = taken off, null if the frame isn't a wear event.
     */
    fun parseWearEvent(data: ByteArray): Boolean? {
        if (data.size < 2 || data[0] != OP_WEAR_DETECT) return null
        return when (data[1]) {
            0x06.toByte() -> true
            0x07.toByte() -> false
            else -> null
        }
    }
}
