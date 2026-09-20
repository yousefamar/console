package io.amar.console.data.chat

import io.amar.console.data.inbox.roomDraft
import io.amar.console.data.inbox.roomDraftUpdatedAt
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The composer↔hub draft rules from the SPA's ChatComposeInput (^bold-lynx). */
class ChatDraftSyncTest {

    @Test
    fun `first hub read hydrates the composer`() {
        val s = ChatDraftSync()
        assertEquals("hello", s.onRemote("hello", current = "", editing = false, now = 1000))
        assertEquals("hello", s.hubDraft)
        assertEquals("hello", s.synced)
    }

    @Test
    fun `first read replaces the on-device cache — the hub is the authority on open`() {
        // Unlike the SPA (an empty textarea per room switch), the field is
        // prefilled from DraftStore; a stale cache must not beat the hub.
        assertEquals("hub copy", ChatDraftSync().onRemote("hub copy", current = "stale cache", editing = false, now = 1000))
        assertEquals("", ChatDraftSync().onRemote("", current = "stale cache", editing = false, now = 1000))
    }

    @Test
    fun `a healed mirror inside the echo window is tracked, so the next flush re-pushes`() {
        // A push that terminally failed heals the row back to the hub's copy;
        // the composer keeps the typed text but the mirror now says "" — the
        // rule "compare against the ROOM ROW, not our own last push" is what
        // makes the next blur retry it instead of believing it landed.
        val s = ChatDraftSync()
        s.onRemote("", current = "", editing = false, now = 1000)
        assertEquals("hel", s.flush("hel", editing = false, now = 5000))
        assertNull(s.onRemote("", current = "hel", editing = false, now = 5400))
        assertEquals("", s.hubDraft)
        assertEquals("hel", s.flush("hel", editing = false, now = 6000))
    }

    @Test
    fun `first read that equals the local cache applies nothing`() {
        val s = ChatDraftSync()
        assertNull(s.onRemote("hello", current = "hello", editing = false, now = 1000))
        assertEquals("hello", s.synced)
    }

    @Test
    fun `nothing is pushed before the first read`() {
        val s = ChatDraftSync()
        assertNull(s.flush("typed offline", editing = false, now = 1000))
    }

    @Test
    fun `flush pushes only when the text differs from the mirror`() {
        val s = ChatDraftSync()
        s.onRemote("", current = "", editing = false, now = 1000)
        assertEquals("hi", s.flush("hi", editing = false, now = 2000))
        assertNull(s.flush("hi", editing = false, now = 2500))
        assertEquals("", s.flush("", editing = false, now = 3000))
    }

    @Test
    fun `remote change replaces the text only when nothing unsaved is typed`() {
        val s = ChatDraftSync()
        s.onRemote("a", current = "", editing = false, now = 1000)
        // Agent wrote a draft; the field still shows what we last synced → apply.
        assertEquals("agent reply", s.onRemote("agent reply", current = "a", editing = false, now = 20_000))
        // Local typing in progress ("agent reply" + more) → keep the typing; synced still advances.
        assertNull(s.onRemote("another device", current = "agent reply typing", editing = false, now = 40_000))
        assertEquals("another device", s.synced)
        // …and the next flush overwrites the hub with the local text.
        assertEquals("agent reply typing", s.flush("agent reply typing", editing = false, now = 41_000))
    }

    @Test
    fun `a remote value within 1500ms of our own write is an echo and is ignored`() {
        val s = ChatDraftSync()
        s.onRemote("", current = "", editing = false, now = 1000)
        assertEquals("hel", s.flush("hel", editing = false, now = 5000))
        // Delta computed before our write landed echoes the PREVIOUS draft.
        assertNull(s.onRemote("", current = "hel", editing = false, now = 5400))
        assertEquals("hel", s.synced)
        // Past the window a genuinely different hub value applies again.
        assertEquals("from desktop", s.onRemote("from desktop", current = "hel", editing = false, now = 7000))
    }

    @Test
    fun `edit mode never persists and never hydrates, afterEdit restores the draft`() {
        val s = ChatDraftSync()
        s.onRemote("draft", current = "", editing = false, now = 1000)
        assertNull(s.flush("the message being edited", editing = true, now = 2000))
        assertNull(s.onRemote("changed remotely", current = "the message being edited", editing = true, now = 3000))
        // The mirror was still tracked so leaving edit mode shows the latest draft.
        assertEquals("changed remotely", s.afterEdit())
        assertEquals("changed remotely", s.synced)
    }

    @Test
    fun `reset forgets the room`() {
        val s = ChatDraftSync()
        s.onRemote("x", current = "", editing = false, now = 1000)
        s.reset()
        assertNull(s.hubDraft)
        assertNull(s.flush("y", editing = false, now = 2000))
    }

    @Test
    fun `withRoomDraft patches rawJson like the hub store and clears on empty`() {
        val raw = """{"name":"Room","isUnread":true,"snoozedUntil":null}"""
        val withText = withRoomDraft(raw, "hello\nthere", now = 123L)
        assertEquals("hello\nthere", roomDraft(withText))
        assertEquals(123L, roomDraftUpdatedAt(withText))
        assertEquals("Room", Json.parseToJsonElement(withText).jsonObject["name"]!!.jsonPrimitive.content)
        val cleared = withRoomDraft(withText, "   ", now = 456L)
        assertNull(roomDraft(cleared))
        assertEquals(0L, roomDraftUpdatedAt(cleared))
        assertEquals("Room", Json.parseToJsonElement(cleared).jsonObject["name"]!!.jsonPrimitive.content)
    }
}
