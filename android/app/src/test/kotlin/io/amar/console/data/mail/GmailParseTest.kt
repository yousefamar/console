package io.amar.console.data.mail

import android.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class) // Base64 is android.util
class GmailParseTest {

    private fun b64(s: String): String =
        Base64.encodeToString(s.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP)

    private fun thread(json: String) = Json.parseToJsonElement(json).jsonObject

    private fun fullThread(): kotlinx.serialization.json.JsonObject = thread(
        """{
          "id": "thr1",
          "messages": [
            {
              "id": "m1", "threadId": "thr1", "internalDate": "1700000000000",
              "labelIds": ["INBOX", "UNREAD"],
              "snippet": "Hi there...",
              "payload": {
                "mimeType": "multipart/alternative",
                "headers": [
                  {"name": "From", "value": "Alice Smith <alice@x.com>"},
                  {"name": "To", "value": "yousef@amar.io"},
                  {"name": "Subject", "value": "Lunch?"}
                ],
                "parts": [
                  {"mimeType": "text/plain", "body": {"data": "${b64("plain body")}"}},
                  {"mimeType": "text/html", "body": {"data": "${b64("<p>html body</p>")}"}}
                ]
              }
            },
            {
              "id": "m2", "threadId": "thr1", "internalDate": "1700000100000",
              "labelIds": ["INBOX"],
              "snippet": "Sure!",
              "payload": {
                "mimeType": "multipart/mixed",
                "headers": [
                  {"name": "From", "value": "bob@y.com"},
                  {"name": "Subject", "value": "Re: Lunch?"}
                ],
                "parts": [
                  {"mimeType": "text/plain", "body": {"data": "${b64("sure")}"}},
                  {"mimeType": "application/pdf", "filename": "menu.pdf",
                   "body": {"attachmentId": "att1", "size": 12345}}
                ]
              }
            }
          ]
        }"""
    )

    @Test
    fun `parses thread row from a full thread`() {
        val (row, msgs) = GmailParse.threadRows(fullThread(), "yousef@amar.io")!!
        assertEquals("thr1", row.id)
        assertEquals("Re: Lunch?", row.subject)          // last message's subject
        assertEquals("bob@y.com", row.fromEmail)
        assertEquals(2, row.messageCount)
        assertTrue(row.isUnread)                          // any message UNREAD
        assertTrue(row.isInbox)
        assertTrue(row.hasAttachments)
        assertEquals(1700000100000L, row.date)
        assertEquals(2, msgs.size)
    }

    @Test
    fun `extracts html and plain bodies`() {
        val (_, msgs) = GmailParse.threadRows(fullThread(), "a@b.c")!!
        assertEquals("<p>html body</p>", msgs[0].bodyHtml)
        assertEquals("plain body", msgs[0].bodyText)
        assertNull(msgs[1].bodyHtml)
        assertEquals("sure", msgs[1].bodyText)
    }

    @Test
    fun `extracts attachment metadata`() {
        val (_, msgs) = GmailParse.threadRows(fullThread(), "a@b.c")!!
        assertNull(msgs[0].attachmentsJson)
        val att = msgs[1].attachmentsJson!!
        assertTrue(att.contains("menu.pdf"))
        assertTrue(att.contains("att1"))
        assertTrue(att.contains("12345"))
    }

    @Test
    fun `parseAddress handles both forms`() {
        assertEquals("Alice Smith" to "alice@x.com", GmailParse.parseAddress("Alice Smith <alice@x.com>"))
        assertEquals("bob@y.com" to "bob@y.com", GmailParse.parseAddress("bob@y.com"))
        assertEquals("a@b.c" to "a@b.c", GmailParse.parseAddress("\"\" <a@b.c>"))
    }

    @Test
    fun `archived thread is not inbox`() {
        val t = thread(
            """{"id":"t2","messages":[{"id":"m1","internalDate":"1","labelIds":["SENT"],
                "snippet":"x","payload":{"headers":[{"name":"From","value":"a@b.c"},
                {"name":"Subject","value":"s"}]}}]}"""
        )
        val (row, _) = GmailParse.threadRows(t, "a@b.c")!!
        assertFalse(row.isInbox)
        assertFalse(row.isUnread)
    }

    @Test
    fun `malformed thread returns null`() {
        assertNull(GmailParse.threadRows(thread("""{"id":"x","messages":[]}"""), "a@b.c"))
        assertNull(GmailParse.threadRows(thread("""{"messages":[{"id":"m"}]}"""), "a@b.c"))
    }

    @Test
    fun `nested multipart bodies are found`() {
        val t = thread(
            """{"id":"t3","messages":[{"id":"m1","internalDate":"5","labelIds":["INBOX"],
                "snippet":"s","payload":{
                  "mimeType":"multipart/mixed",
                  "headers":[{"name":"From","value":"a@b.c"},{"name":"Subject","value":"s"}],
                  "parts":[{"mimeType":"multipart/alternative","parts":[
                    {"mimeType":"text/html","body":{"data":"${b64("<b>deep</b>")}"}}
                  ]}]}}]}"""
        )
        val (_, msgs) = GmailParse.threadRows(t, "a@b.c")!!
        assertEquals("<b>deep</b>", msgs[0].bodyHtml)
    }

    @Test
    fun `messageRow with keepBody=false skips body decode`() {
        val msg = (fullThread()["messages"] as kotlinx.serialization.json.JsonArray)[0].jsonObject
        val row = GmailParse.messageRow(msg, "thr1", keepBody = false)!!
        assertNull(row.bodyHtml)
        assertNotNull(row.bodyText) // falls back to snippet
    }
}
