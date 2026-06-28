package io.amar.console.pen

/**
 * Neo smartpen ProtocolV2 codec — pure, no Android deps, unit-testable off-device.
 * Mirrors glasses/G1Protocol.kt. Authoritative spec: docs/neo-pen-protocol.md.
 *
 * Wire frame (between the 0xC0/0xC1 delimiters, everything byte-stuffed):
 *   request / non-event response:  cmd(1) | resultCode(1) | len_lo | len_hi | data[len]
 *   pen->host EVENT (0x60..0x6F, 0x78..0x7F, 0x24, 0x32):  cmd(1) | len_lo | len_hi | data[len]
 * Requests we BUILD use the no-error header (cmd | len_lo | len_hi | data) per
 * ProtocolParser20's 1-arg PacketBuilder.allocate. len is LITTLE-ENDIAN, payload only.
 *
 * SAFETY: this module intentionally contains NO offline-request / remove / disk-reset
 * builders. Those land in Phase 2 with the keep-flag hard-forced. Nothing here can
 * construct a frame that erases the pen.
 */
object PenProtocol {
    const val STX = 0xC0
    const val ETX = 0xC1
    const val DLE = 0x7D
    const val ESC = 0x20

    // host -> pen requests
    const val REQ_PenInfo = 0x01
    const val REQ_Password = 0x02
    const val REQ_PenStatus = 0x04
    const val REQ_PenStatusChange = 0x05

    // pen -> host responses
    const val RES_PenInfo = 0x81
    const val RES_Password = 0x82
    const val RES_PenStatus = 0x84

    // pen -> host events (unsolicited)
    const val EVT_Battery = 0x61
    const val EVT_PowerOff = 0x62
    const val EVT_PenDownLegacy = 0x63
    const val EVT_DotLegacy = 0x65
    const val EVT_PenDown = 0x69       // separate-updown V2
    const val EVT_PenUp = 0x6A
    const val EVT_IdChange = 0x6B      // page (Ncode address) change
    const val EVT_Dot = 0x6C           // the canonical live dot
    const val EVT_DotHover = 0x6F

    // offline data transfer (read + keep only)
    const val REQ_OfflineNoteList = 0x21
    const val REQ_OfflinePageList = 0x22
    const val REQ_OfflineDataRequest = 0x23
    const val RES_OfflineChunk = 0x24
    const val ACK_OfflineChunk = 0xA4
    const val RES_OfflineNoteList = 0xA1
    const val RES_OfflinePageList = 0xA2
    const val RES_OfflineDataReq = 0xA3

    // establish defaults (CommProcessor20: appType 0x1101, protoVer "2.12" = separate up/down)
    const val APP_TYPE: Int = 0x1101
    const val PROTO_VER = "2.12"

    fun isEvent(cmd: Int): Boolean =
        cmd in 0x60..0x6F || cmd in 0x78..0x7F || cmd == 0x24 || cmd == 0x32

    // ---- escaping ----------------------------------------------------------
    fun escape(body: ByteArray): ByteArray {
        val out = ArrayList<Byte>(body.size + 8)
        for (b in body) {
            val v = b.toInt() and 0xFF
            if (v == STX || v == ETX || v == DLE) {
                out.add(DLE.toByte()); out.add((v xor ESC).toByte())
            } else out.add(b)
        }
        return out.toByteArray()
    }

    fun unescape(body: ByteArray): ByteArray {
        val out = ArrayList<Byte>(body.size)
        var i = 0
        while (i < body.size) {
            val v = body[i].toInt() and 0xFF
            if (v == DLE) {
                i++; if (i >= body.size) break
                out.add(((body[i].toInt() and 0xFF) xor ESC).toByte())
            } else out.add(body[i])
            i++
        }
        return out.toByteArray()
    }

    // ---- request framing ---------------------------------------------------
    fun encodeRequest(cmd: Int, data: ByteArray = ByteArray(0)): ByteArray {
        val len = data.size
        val body = ByteArray(3 + len)
        body[0] = cmd.toByte()
        body[1] = (len and 0xFF).toByte()
        body[2] = ((len shr 8) and 0xFF).toByte()
        System.arraycopy(data, 0, body, 3, len)
        val esc = escape(body)
        val frame = ByteArray(esc.size + 2)
        frame[0] = STX.toByte()
        System.arraycopy(esc, 0, frame, 1, esc.size)
        frame[esc.size + 1] = ETX.toByte()
        return frame
    }

    /** Hard guard for the raw-debug path: opcodes/payloads that could erase data or
     *  lock us out. Refused so interactive probing can never destroy anything. */
    fun isDestructive(cmd: Int, data: ByteArray): Boolean = when (cmd) {
        0x25, 0x27 -> true                                  // offline note/page remove
        0x03 -> true                                        // password set/change (lockout risk)
        REQ_OfflineDataRequest -> data.isEmpty() || (data[0].toInt() and 0xFF) != 2  // 0x23 unless KEEP
        REQ_PenStatusChange -> data.isNotEmpty() && (data[0].toInt() and 0xFF) == 0x11  // 0x05 Disk_Reset
        else -> false
    }

    // ---- inbound frame parsing --------------------------------------------
    data class Frame(
        val cmd: Int, val result: Int, val data: ByteArray, val isEvent: Boolean,
        val body: ByteArray = ByteArray(0),   // full unescaped frame body (cmd..data), for faithful logging
    ) {
        val ok: Boolean get() = isEvent || result == 0x00
    }

    /** Streaming parser: feed raw GATT notification bytes, get back complete frames.
     *  Tolerates frames split across notifications and leading garbage. */
    class Parser {
        private val buf = ArrayList<Byte>(256)
        private var inFrame = false

        fun reset() { buf.clear(); inFrame = false }

        fun feed(chunk: ByteArray): List<Frame> {
            val frames = ArrayList<Frame>()
            for (b in chunk) {
                when (b.toInt() and 0xFF) {
                    STX -> { buf.clear(); inFrame = true }
                    ETX -> { if (inFrame) decode(buf.toByteArray())?.let { frames.add(it) }; inFrame = false; buf.clear() }
                    else -> if (inFrame) buf.add(b)
                }
            }
            return frames
        }

        private fun decode(escaped: ByteArray): Frame? {
            val body = unescape(escaped)
            if (body.isEmpty()) return null
            val cmd = body[0].toInt() and 0xFF
            return if (isEvent(cmd)) {
                if (body.size < 3) return Frame(cmd, 0, ByteArray(0), true)
                val len = u16le(body, 1)
                Frame(cmd, 0, body.copyOfRange(3, minOf(3 + len, body.size)), true, body)
            } else {
                if (body.size < 4) return Frame(cmd, if (body.size >= 2) body[1].toInt() and 0xFF else -1, ByteArray(0), false, body)
                val result = body[1].toInt() and 0xFF
                val len = u16le(body, 2)
                Frame(cmd, result, body.copyOfRange(4, minOf(4 + len, body.size)), false, body)
            }
        }
    }

    // ---- request builders (non-destructive only) --------------------------
    fun buildReqPenInfo(appVer: String = "", appType: Int = APP_TYPE, protoVer: String = PROTO_VER): ByteArray {
        val data = ByteArray(16 + 2 + 16 + 8)
        // [0..15] app name — SDK writes empty string (zeros)
        writeAscii(data, 16, "", 16)
        // [16..17] appType u16 LE
        data[16] = (appType and 0xFF).toByte()
        data[17] = ((appType shr 8) and 0xFF).toByte()
        // [18..33] app version
        writeAscii(data, 18, appVer, 16)
        // [34..41] requested protocol version
        writeAscii(data, 34, protoVer, 8)
        return encodeRequest(REQ_PenInfo, data)
    }

    fun buildReqPenStatus(): ByteArray = encodeRequest(REQ_PenStatus)

    /** Set the pen RTC (REQ_PenStatusChange subtype 0x01, 8-byte LE millis). Required
     *  after auth — the pen refuses offline enumeration (FAIL2) until its clock is set. */
    fun buildSetRtc(nowMs: Long): ByteArray {
        val d = ByteArray(9)
        d[0] = 0x01  // CurrentTimeSet subtype
        for (i in 0 until 8) d[1 + i] = ((nowMs shr (8 * i)) and 0xFF).toByte()
        return encodeRequest(REQ_PenStatusChange, d)
    }

    /** 0x02 — only used if the pen reports isLock. 16 bytes ASCII, NUL-padded.
     *  Note: the SDK refuses "0000" (treats it as the no-password sentinel). */
    fun buildPasswordInput(password: String): ByteArray {
        val data = ByteArray(16)
        writeAscii(data, 0, password, 16)
        return encodeRequest(REQ_Password, data)
    }

    // ---- response / event parsers -----------------------------------------
    data class PenInfo(val name: String, val firmware: String, val protocol: String)
    fun parsePenInfo(f: Frame): PenInfo =
        PenInfo(ascii(f.data, 0, 16), ascii(f.data, 16, 16), ascii(f.data, 32, 8))

    data class PenStatus(
        val isLock: Boolean, val batteryPct: Int, val usedMemPct: Int,
        val offlineSaveOn: Boolean, val maxPress: Int, val autoPowerOffMin: Int,
    )
    fun parsePenStatus(f: Frame): PenStatus {
        val d = f.data
        val maxP = u16le(d, 13).let { if (it == 0) 852 else it }
        return PenStatus(
            isLock = u8(d, 0) != 0,
            batteryPct = u8(d, 20),
            usedMemPct = u8(d, 15),
            offlineSaveOn = u8(d, 21) != 0,
            maxPress = maxP,
            autoPowerOffMin = u16le(d, 11),
        )
    }

    /** Page (Ncode address) change — 0x6B. */
    data class PageAddr(val section: Int, val owner: Int, val note: Long, val page: Long)
    fun parseIdChange(f: Frame): PageAddr {
        val d = f.data
        val owner = u8(d, 1) or (u8(d, 2) shl 8) or (u8(d, 3) shl 16)
        return PageAddr(section = u8(d, 4), owner = owner, note = u32le(d, 5), page = u32le(d, 9))
    }

    /** Live dot — 0x6C. x = X + fx*0.01 (doc 5.4). timeDelta adds to the prior dot ts. */
    data class DotEvent(
        val x: Float, val y: Float, val force: Int,
        val tiltX: Int, val tiltY: Int, val twist: Int, val timeDelta: Int,
    )
    fun parseDot(f: Frame): DotEvent {
        val d = f.data
        val xi = u16le(d, 4); val yi = u16le(d, 6)
        val fx = u8(d, 8); val fy = u8(d, 9)
        return DotEvent(
            x = xi + fx * 0.01f,
            y = yi + fy * 0.01f,
            force = u16le(d, 2),
            tiltX = u8(d, 10), tiltY = u8(d, 11), twist = u16le(d, 12),
            timeDelta = u8(d, 1),
        )
    }

    // ---- offline data: KEEP-ONLY (read + retrieve, never erase) ------------
    // SAFETY: there are deliberately NO remove (0x25/0x27) or disk-reset (0x11)
    // builders in this module. The retrieve request's delete byte is hard-wired to
    // 2 = KEEP (buildPullPageKeep takes no delete parameter). Nothing here can erase.

    fun buildReqOfflineNoteListAll(): ByteArray =
        encodeRequest(REQ_OfflineNoteList, byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()))

    fun buildReqOfflinePageList(section: Int, owner: Int, note: Long): ByteArray =
        encodeRequest(REQ_OfflinePageList, owner3(owner) + byteArrayOf(section.toByte()) + u32(note))

    /** Retrieve ONE page, KEEP it on the pen. Delete byte hard-wired to 2; compress 0
     *  (the F130 is protocol 2.20, which predates the 2.22 compression support). */
    fun buildPullPageKeep(section: Int, owner: Int, note: Long, pageId: Long): ByteArray {
        val d = byteArrayOf(2, 0) +                  // [0]=2 KEEP, [1]=0 no-compress
            owner3(owner) + byteArrayOf(section.toByte()) +
            u32(note) + u32(1L) + u32(pageId)        // pageCount=1, then the one page id
        return encodeRequest(REQ_OfflineDataRequest, d)
    }

    /** Ack a received chunk (0xA4, response-format with a 0x00 error byte). */
    fun buildOfflineChunkAck(packetId: Int, position: Int): ByteArray {
        val isContinue = if (position == 2) 0 else 1
        val d = byteArrayOf((packetId and 0xFF).toByte(), ((packetId shr 8) and 0xFF).toByte(), isContinue.toByte())
        return encodeResponse(ACK_OfflineChunk, 0, d)
    }

    /** Response-format frame (cmd | errorCode | len_lo | len_hi | data), escaped. */
    private fun encodeResponse(cmd: Int, errorCode: Int, data: ByteArray): ByteArray {
        val len = data.size
        val body = ByteArray(4 + len)
        body[0] = cmd.toByte(); body[1] = errorCode.toByte()
        body[2] = (len and 0xFF).toByte(); body[3] = ((len shr 8) and 0xFF).toByte()
        System.arraycopy(data, 0, body, 4, len)
        val esc = escape(body)
        return byteArrayOf(STX.toByte()) + esc + byteArrayOf(ETX.toByte())
    }

    data class OfflineNote(val section: Int, val owner: Int, val note: Long)
    fun parseOfflineNoteList(f: Frame): List<OfflineNote> {
        val out = ArrayList<OfflineNote>()
        val d = f.data
        val count = u16le(d, 0)
        var o = 2
        repeat(count) {
            if (o + 8 <= d.size) {
                val owner = u8(d, o) or (u8(d, o + 1) shl 8) or (u8(d, o + 2) shl 16)
                out.add(OfflineNote(u8(d, o + 3), owner, u32le(d, o + 4)))
            }
            o += 8
        }
        return out
    }

    data class OfflinePages(val section: Int, val owner: Int, val note: Long, val pages: List<Long>)
    fun parseOfflinePageList(f: Frame): OfflinePages {
        val d = f.data
        val owner = u8(d, 0) or (u8(d, 1) shl 8) or (u8(d, 2) shl 16)
        val count = u16le(d, 8)
        val pages = ArrayList<Long>()
        var o = 10
        repeat(count) { if (o + 4 <= d.size) pages.add(u32le(d, o)); o += 4 }
        return OfflinePages(u8(d, 3), owner, u32le(d, 4), pages)
    }

    data class OfflineHeader(val strokeCount: Long, val totalSize: Long, val compressed: Boolean)
    fun parseOfflineHeader(f: Frame): OfflineHeader =
        OfflineHeader(u32le(f.data, 0), u32le(f.data, 4), u8(f.data, 8) == 1)

    data class OfflineChunk(val packetId: Int, val position: Int)
    fun parseOfflineChunk(f: Frame): OfflineChunk = OfflineChunk(u16le(f.data, 0), u8(f.data, 7))

    private fun owner3(owner: Int): ByteArray = byteArrayOf(
        (owner and 0xFF).toByte(), ((owner shr 8) and 0xFF).toByte(), ((owner shr 16) and 0xFF).toByte(),
    )
    private fun u32(v: Long): ByteArray = byteArrayOf(
        (v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte(),
        ((v shr 16) and 0xFF).toByte(), ((v shr 24) and 0xFF).toByte(),
    )

    // ---- helpers -----------------------------------------------------------
    private fun u8(d: ByteArray, off: Int): Int = if (off < d.size) d[off].toInt() and 0xFF else 0
    private fun u16le(d: ByteArray, off: Int): Int = u8(d, off) or (u8(d, off + 1) shl 8)
    private fun u32le(d: ByteArray, off: Int): Long =
        (u8(d, off).toLong()) or (u8(d, off + 1).toLong() shl 8) or
        (u8(d, off + 2).toLong() shl 16) or (u8(d, off + 3).toLong() shl 24)

    private fun writeAscii(dst: ByteArray, off: Int, s: String, n: Int) {
        val src = s.toByteArray(Charsets.US_ASCII)
        for (i in 0 until n) dst[off + i] = if (i < src.size) src[i] else 0
    }

    private fun ascii(d: ByteArray, off: Int, n: Int): String {
        if (off >= d.size) return ""
        val end = minOf(off + n, d.size)
        return String(d, off, end - off, Charsets.US_ASCII).trim(' ', ' ')
    }

    fun name(cmd: Int): String = when (cmd) {
        RES_PenInfo -> "RES_PenInfo"; RES_Password -> "RES_Password"; RES_PenStatus -> "RES_PenStatus"
        EVT_Battery -> "EVT_Battery"; EVT_PowerOff -> "EVT_PowerOff"
        EVT_PenDown -> "EVT_PenDown"; EVT_PenUp -> "EVT_PenUp"
        EVT_IdChange -> "EVT_IdChange"; EVT_Dot -> "EVT_Dot"; EVT_DotHover -> "EVT_DotHover"
        EVT_PenDownLegacy -> "EVT_PenDown(legacy)"; EVT_DotLegacy -> "EVT_Dot(legacy)"
        0x24 -> "RES_OfflineChunk"; 0xA1 -> "RES_OfflineNoteList"; 0xA2 -> "RES_OfflinePageList"
        0xA3 -> "RES_OfflineDataRequest"
        else -> "0x%02X".format(cmd)
    }

    /** Research-log classification by command byte (mirrors glasses' frame `kind`). */
    fun kind(cmd: Int): String = when (cmd) {
        RES_PenInfo, RES_PenStatus, RES_Password, 0x85, 0x91 -> "info"
        EVT_Dot, EVT_DotHover, EVT_PenDown, EVT_PenUp, EVT_IdChange,
        EVT_PenDownLegacy, EVT_DotLegacy, 0x66, 0x67 -> "dot"
        EVT_Battery -> "battery"
        EVT_PowerOff -> "power"
        0x24, 0xA1, 0xA2, 0xA3, 0xA5, 0xA6, 0xA7 -> "offline"
        else -> "unhandled"
    }
}
