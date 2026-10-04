package io.amar.console.data.money

import io.amar.console.data.db.MoneyTxRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `money:override` payload builder, the optimistic classification and the heal. */
class MoneyOverridesTest {

    private fun row(cat: String? = "cat_food", ignored: Boolean = false, transfer: Boolean = false) = MoneyTxRow(
        id = "tx_1", amount = -1200, currency = "GBP", created = "2026-10-01T12:00:00Z", createdAt = 0, settled = "",
        description = "TESCO", merchantName = "Tesco", merchantEmoji = null, merchantLogo = null, counterpartyName = null,
        monzoCategory = "groceries", declineReason = null, notes = null, categoryId = cat, ignored = ignored, isTransfer = transfer,
    )

    private fun body(edit: OverrideEdit) = Json.parseToJsonElement(MoneyOverrides.requestBody("tx_1", edit)!!).jsonObject.toString()

    @Test
    fun `request bodies match what the SPA posts, with ignore cleared on a pick`() {
        assertEquals("""{"txId":"tx_1","categoryId":"cat_bills","ignore":false}""", body(OverrideEdit.SetCategory("cat_bills")))
        assertEquals("""{"txId":"tx_1","ignore":true}""", body(OverrideEdit.Ignore(true)))
        assertEquals("""{"txId":"tx_1","ignore":false}""", body(OverrideEdit.Ignore(false)))
        assertEquals("""{"txId":"tx_1","categoryId":"cat_transfer","ignore":false}""", body(OverrideEdit.Transfer(true)))
        assertEquals("""{"txId":"tx_1","categoryId":"cat_uncat","ignore":false}""", body(OverrideEdit.Transfer(false)))
        assertNull(MoneyOverrides.requestBody("tx_1", OverrideEdit.Reset)) // = DELETE
    }

    @Test
    fun `merged override follows the hub's merge upsert`() {
        val ignored = MoneyOverrides.mergedOverride(TxOverride("tx_1", categoryId = "cat_food"), "tx_1", OverrideEdit.Ignore(true))
        assertEquals(TxOverride("tx_1", "cat_food", true), ignored)
        assertEquals(TxOverride("tx_1", "cat_bills", false), MoneyOverrides.mergedOverride(ignored, "tx_1", OverrideEdit.SetCategory("cat_bills")))
        assertNull(MoneyOverrides.mergedOverride(ignored, "tx_1", OverrideEdit.Reset))
    }

    @Test
    fun `optimistic classification mirrors effectiveCategory's override branch`() {
        val t = MoneyOverrides.optimistic(row(), TxOverride("tx_1", "cat_transfer", false))
        assertEquals("cat_transfer", t.categoryId); assertTrue(t.isTransfer); assertFalse(t.ignored)
        val i = MoneyOverrides.optimistic(row(transfer = true, cat = "cat_transfer"), TxOverride("tx_1", null, true))
        assertTrue(i.ignored); assertFalse(i.isTransfer) // ignore beats transfer
        val c = MoneyOverrides.optimistic(row(ignored = true), TxOverride("tx_1", "cat_bills", false))
        assertEquals("cat_bills", c.categoryId); assertFalse(c.ignored)
        assertEquals(row(), MoneyOverrides.optimistic(row(), null)) // reset waits for the hub
    }

    @Test
    fun `action round-trips and the heal restores the before classification`() {
        val a = MoneyOverrides.Action(
            txId = "tx_1", body = MoneyOverrides.requestBody("tx_1", OverrideEdit.Ignore(true)),
            before = TxClassification("cat_food", false, false), beforeOverride = TxOverride("tx_1", "cat_food", null),
        )
        val back = MoneyOverrides.decodeAction(MoneyOverrides.encodeAction(a))!!
        assertEquals(a, back)
        val reset = MoneyOverrides.decodeAction(MoneyOverrides.encodeAction(a.copy(body = null, beforeOverride = null)))!!
        assertNull(reset.body); assertNull(reset.beforeOverride)

        val healed = MoneyOverrides.healed(row(ignored = true, cat = "cat_food"), back.before)
        assertEquals(row(), healed)
        assertEquals(row(ignored = true), MoneyOverrides.healed(row(ignored = true), null))
    }

    @Test
    fun `override list parses the hub shape and survives the meta cache`() {
        val m = MoneyOverrides.parseOverrides("""[{"txId":"a","categoryId":"cat_x","pairedTxId":"b"},{"txId":"c","ignore":true},{"nope":1}]""")
        assertEquals(setOf("a", "c"), m.keys)
        assertEquals(TxOverride("c", null, true), m["c"])
        assertEquals(m, MoneyOverrides.parseOverrides(MoneyOverrides.encodeOverrides(m)))
    }
}
