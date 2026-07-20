package io.amar.console.data.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatEventsTest {

    private fun ev(json: String) = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `plain text message converts`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e1","sender":"@alice:x","type":"m.room.message",
                 "origin_server_ts":1000,"content":{"msgtype":"m.text","body":"hello"}}"""),
            "!r",
        )
        assertNotNull(msg)
        assertEquals("hello", msg!!.body)
        assertEquals("m.text", msg.msgtype)
        assertEquals("alice", msg.senderName)
        assertEquals(1000L, msg.timestamp)
    }

    @Test
    fun `image message carries mxc url and mime`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e2","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                 "content":{"msgtype":"m.image","body":"pic.jpg","url":"mxc://x/abc",
                            "info":{"mimetype":"image/jpeg"}}}"""),
            "!r",
        )!!
        assertEquals("mxc://x/abc", msg.mediaMxc)
        assertEquals("image/jpeg", msg.mediaMime)
    }

    @Test
    fun `encrypted media rides the file field`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e3","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                 "content":{"msgtype":"m.image","body":"pic",
                            "file":{"url":"mxc://x/enc","key":{"k":"z"},"iv":"iv"}}}"""),
            "!r",
        )!!
        assertEquals("mxc://x/enc", msg.mediaMxc)
        assertNotNull(msg.encryptedFileJson)
    }

    @Test
    fun `undecryptable event renders lock placeholder`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e4","sender":"@a:x","type":"m.room.encrypted","origin_server_ts":1,
                 "content":{"algorithm":"m.megolm.v1.aes-sha2","ciphertext":"opaque"}}"""),
            "!r",
        )!!
        assertTrue(msg.body!!.contains("Encrypted"))
    }

    @Test
    fun `encrypted tombstone (redacted) is skipped`() {
        val event = ev("""{"event_id":"${'$'}e5","sender":"@a:x","type":"m.room.encrypted",
             "origin_server_ts":1,"content":{},
             "unsigned":{"redacted_because":{"sender":"@a:x","type":"m.room.redaction"}}}""")
        assertNull(ChatEvents.eventToMessage(event, "!r"))
        assertTrue(ChatEvents.isEncryptedTombstone(event))
    }

    @Test
    fun `sticker becomes image`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e6","sender":"@a:x","type":"m.sticker","origin_server_ts":1,
                 "content":{"body":"sticker","url":"mxc://x/st"}}"""),
            "!r",
        )!!
        assertEquals("m.image", msg.msgtype)
    }

    @Test
    fun `edit uses new content`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e7","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                 "content":{"msgtype":"m.text","body":"* edited","m.new_content":{"msgtype":"m.text","body":"edited"},
                            "m.relates_to":{"rel_type":"m.replace","event_id":"${'$'}orig"}}}"""),
            "!r",
        )!!
        assertEquals("edited", msg.body)
        assertEquals("m.replace", ChatEvents.relType(
            ev("""{"type":"m.room.message","content":{"m.relates_to":{"rel_type":"m.replace","event_id":"${'$'}o"}}}""")
        ))
    }

    @Test
    fun `redaction detection`() {
        val red = ev("""{"event_id":"${'$'}e8","sender":"@a:x","type":"m.room.redaction",
             "origin_server_ts":1,"content":{},"redacts":"${'$'}target"}""")
        assertTrue(ChatEvents.isRedaction(red))
        assertEquals("\$target", ChatEvents.redactsEventId(red))
    }

    @Test
    fun `reply relation extracted`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e9","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                 "content":{"msgtype":"m.text","body":"re",
                            "m.relates_to":{"m.in_reply_to":{"event_id":"${'$'}parent"}}}}"""),
            "!r",
        )!!
        assertTrue(msg.replyToJson!!.contains("\$parent"))
    }

    @Test
    fun `own echo transaction id surfaces`() {
        val event = ev("""{"event_id":"${'$'}e10","sender":"@me:x","type":"m.room.message",
             "origin_server_ts":1,"content":{"msgtype":"m.text","body":"hi"},
             "unsigned":{"transaction_id":"apk-uuid-1"}}""")
        assertEquals("apk-uuid-1", ChatEvents.transactionId(event))
    }

    @Test
    fun `state events and unknown types are ignored`() {
        assertNull(ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}e11","sender":"@a:x","type":"m.room.member","origin_server_ts":1,
                 "content":{"membership":"join"}}"""), "!r"))
    }

    @Test
    fun `audio carries waveform and voice-note flag`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}v","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                 "content":{"msgtype":"m.audio","body":"voice.ogg","url":"mxc://x/v",
                            "org.matrix.msc1767.audio":{"duration":3000,"waveform":[1,2,3]},
                            "org.matrix.msc3245.voice":{}}}"""),
            "!r",
        )!!
        assertEquals(3000L, msg.mediaDurationMs)
        assertTrue(msg.isVoiceNote)
        assertNotNull(msg.waveformJson)
        assertTrue(msg.waveformJson!!.contains("2"))
    }

    @Test
    fun `image carries width and height from info`() {
        val msg = ChatEvents.eventToMessage(
            ev("""{"event_id":"${'$'}i","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
                 "content":{"msgtype":"m.image","body":"p.jpg","url":"mxc://x/i",
                            "info":{"mimetype":"image/jpeg","w":640,"h":480}}}"""),
            "!r",
        )!!
        assertEquals(640, msg.mediaWidth)
        assertEquals(480, msg.mediaHeight)
    }

    @Test
    fun `bridge sender prefix stripped from body only when it matches`() {
        assertEquals("hi there", ChatEvents.displayBody("Bob: hi there", "Bob"))
        assertEquals("Alice: hi", ChatEvents.displayBody("Alice: hi", "Bob"))
        assertEquals("no colon", ChatEvents.displayBody("no colon", "Bob"))
    }

    @Test
    fun `send-status parts extracted`() {
        val ev = ev("""{"event_id":"${'$'}s","sender":"@bot:x","type":"com.beeper.message_send_status",
             "origin_server_ts":1,"content":{"status":"FAIL_RETRIABLE","reason":"undecryptable_event",
                "m.relates_to":{"event_id":"${'$'}orig"}}}""")
        assertTrue(ChatEvents.isSendStatus(ev))
        val (target, status, reason) = ChatEvents.sendStatusParts(ev)!!
        assertEquals("\$orig", target)
        assertEquals("FAIL_RETRIABLE", status)
        assertEquals("undecryptable_event", reason)
    }

    @Test
    fun `edit content prefers new_content`() {
        val ev = ev("""{"event_id":"${'$'}e","sender":"@a:x","type":"m.room.message","origin_server_ts":1,
             "content":{"msgtype":"m.text","body":"* fixed",
                        "m.new_content":{"msgtype":"m.text","body":"fixed",
                            "format":"org.matrix.custom.html","formatted_body":"<b>fixed</b>"},
                        "m.relates_to":{"rel_type":"m.replace","event_id":"${'$'}o"}}}""")
        val ec = ChatEvents.editContent(ev)!!
        assertEquals("fixed", ec.body)
        assertEquals("<b>fixed</b>", ec.formattedBody)
    }

    @Test
    fun `room snapshot row converts with defaults`() {
        val row = ChatEvents.roomFromState("!room:x", ev(
            """{"name":"Veronica","isDirect":true,"isUnread":true,"unreadCount":3,
                "lastMessageBody":"see you","lastMessageTime":123456,"isEncrypted":true,
                "memberCount":2,"networkIcon":"whatsapp","prevBatch":"t123"}"""
        ))
        assertEquals("Veronica", row.name)
        assertTrue(row.isDirect)
        assertEquals(3, row.unreadCount)
        assertEquals("whatsapp", row.networkIcon)
        assertEquals("t123", row.prevBatch)
        assertFalse(row.isMuted) // absent → default false
    }
}
