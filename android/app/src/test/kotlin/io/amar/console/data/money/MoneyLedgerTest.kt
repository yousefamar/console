package io.amar.console.data.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure manual-account ledger helpers: pounds parsing, the hub's wire shapes, optimistic state. */
class MoneyLedgerTest {

    private val acc = Account(
        id = "acc_1", name = "Lloyds", type = "manual", liquidity = "liquid",
        ledger = listOf(
            BalanceEntry("bal_a", "2026-08-01", 120_000),
            BalanceEntry("bal_b", "2026-09-01", 150_050, "after rent"),
        ),
    )

    // ---- pounds ↔ pence (SPA Math.round(parseFloat(pounds) * 100)) ----

    @Test
    fun `parsePounds takes the shapes a phone keyboard produces`() {
        assertEquals(0L, MoneyLedger.parsePounds("0"))
        assertEquals(1234L, MoneyLedger.parsePounds("12.34"))
        assertEquals(1_234_500L, MoneyLedger.parsePounds("12345"))
        assertEquals(150_050L, MoneyLedger.parsePounds("1500.50"))
        assertEquals(150_050L, MoneyLedger.parsePounds(" £1,500.50 "))
        assertEquals(-4500L, MoneyLedger.parsePounds("-45"))
        // Rounds to the nearest penny rather than truncating.
        assertEquals(1235L, MoneyLedger.parsePounds("12.345"))
    }

    @Test
    fun `parsePounds refuses anything that is not a finite number`() {
        for (bad in listOf("", "   ", "-", ".", "-.", "abc", "12.3.4", "£", "1e", "NaN", "Infinity")) {
            assertNull("expected null for '$bad'", MoneyLedger.parsePounds(bad))
        }
    }

    @Test
    fun `poundsInput round-trips through parsePounds`() {
        for (pence in listOf(0L, 5L, 99L, 100L, 150_050L, -4500L, 123_456_789L)) {
            assertEquals(pence, MoneyLedger.parsePounds(MoneyLedger.poundsInput(pence)))
        }
        assertEquals("1500.50", MoneyLedger.poundsInput(150_050))
        assertEquals("-45.00", MoneyLedger.poundsInput(-4500))
        assertEquals("0.05", MoneyLedger.poundsInput(5))
    }

    // ---- requests ----

    @Test
    fun `add posts to the account's balance collection without an empty note`() {
        val r = MoneyLedger.requestFor("acc_1", LedgerEdit.Add("2026-10-06", 160_000, "  "))
        assertEquals("POST", r.method)
        assertEquals("/finance/accounts/acc_1/balance", r.path)
        assertEquals("""{"date":"2026-10-06","balancePence":160000}""", r.body)
    }

    @Test
    fun `a patch that cleared the note sends an empty string, because the hub merges`() {
        val r = MoneyLedger.requestFor("acc_1", LedgerEdit.Update("bal_b", "2026-09-02", 150_000, ""))
        assertEquals("PATCH", r.method)
        assertEquals("/finance/accounts/acc_1/balance/bal_b", r.path)
        assertEquals("""{"date":"2026-09-02","balancePence":150000,"note":""}""", r.body)
    }

    @Test
    fun `delete carries no body and url-encodes the ids`() {
        val r = MoneyLedger.requestFor("acc 1", LedgerEdit.Delete("bal/b"))
        assertEquals("DELETE", r.method)
        assertEquals("/finance/accounts/acc+1/balance/bal%2Fb", r.path)
        assertNull(r.body)
    }

    // ---- optimistic state ----

    @Test
    fun `an added reading lands sorted by date with a local id`() {
        val next = MoneyLedger.optimistic(acc, LedgerEdit.Add("2026-08-15", 130_000), localId = "local_x")
        assertEquals(listOf("bal_a", "local_x", "bal_b"), next.ledger.map { it.id })
        val added = next.ledger[1]
        assertTrue(added.isLocal)
        assertEquals(130_000L, added.balancePence)
        assertNull(added.note)
        // The newest reading is what the row shows.
        assertEquals("bal_b", next.latestEntry!!.id)
    }

    @Test
    fun `an edit re-sorts when its date moved and a blank note clears`() {
        val next = MoneyLedger.optimistic(acc, LedgerEdit.Update("bal_b", "2026-07-01", 111_100, ""))
        assertEquals(listOf("bal_b", "bal_a"), next.ledger.map { it.id })
        assertNull(next.ledger.first().note)
        assertEquals(111_100L, next.ledger.first().balancePence)
    }

    @Test
    fun `a delete drops just that reading and an unknown id is a no-op`() {
        assertEquals(listOf("bal_b"), MoneyLedger.optimistic(acc, LedgerEdit.Delete("bal_a")).ledger.map { it.id })
        assertEquals(acc.ledger, MoneyLedger.optimistic(acc, LedgerEdit.Delete("nope")).ledger)
        assertEquals(acc.ledger, MoneyLedger.optimistic(acc, LedgerEdit.Update("nope", "2026-01-01", 1)).ledger)
    }

    @Test
    fun `newestFirst is the render order, sorted is the hub's`() {
        assertEquals(listOf("bal_b", "bal_a"), MoneyLedger.newestFirst(acc.ledger).map { it.id })
        assertEquals(listOf("bal_a", "bal_b"), MoneyLedger.sorted(acc.ledger.reversed()).map { it.id })
    }

    @Test
    fun `healed puts the pre-edit ledger back`() {
        val dirty = MoneyLedger.optimistic(acc, LedgerEdit.Add("2026-10-06", 999, null))
        assertEquals(3, dirty.ledger.size)
        assertEquals(acc.ledger, MoneyLedger.healed(dirty, acc.ledger).ledger)
    }

    @Test
    fun `replace swaps one account and leaves the order alone`() {
        val other = acc.copy(id = "acc_2", name = "Revolut")
        val list = listOf(acc, other)
        val out = MoneyLedger.replace(list, other.copy(name = "Revolut GBP"))
        assertEquals(listOf("acc_1", "acc_2"), out.map { it.id })
        assertEquals("Revolut GBP", out[1].name)
    }

    // ---- outbox payload ----

    @Test
    fun `the action round-trips through the outbox payload with the heal copy`() {
        val a = MoneyLedger.action(acc, LedgerEdit.Add("2026-10-06", 160_000, "checked app"))
        val back = MoneyLedger.decodeAction(MoneyLedger.encodeAction(a))!!
        assertEquals(a.accountId, back.accountId)
        assertEquals("POST", back.method)
        assertEquals(a.path, back.path)
        assertEquals(a.body, back.body)
        assertEquals(acc.ledger, back.beforeLedger)
    }

    @Test
    fun `a delete action round-trips with a null body`() {
        val back = MoneyLedger.decodeAction(MoneyLedger.encodeAction(MoneyLedger.action(acc, LedgerEdit.Delete("bal_a"))))!!
        assertEquals("DELETE", back.method)
        assertNull(back.body)
        assertEquals(2, back.beforeLedger.size)
    }

    @Test
    fun `a bad payload decodes to null rather than throwing`() {
        assertNull(MoneyLedger.decodeAction("not json"))
        assertNull(MoneyLedger.decodeAction("""{"method":"POST","path":"/x"}"""))
    }

    @Test
    fun `parseEntryResponse reads the hub's stored entry`() {
        val e = MoneyLedger.parseEntryResponse("""{"id":"bal_c","date":"2026-10-06","balancePence":160000,"note":"x"}""")!!
        assertEquals("bal_c", e.id)
        assertEquals(160_000L, e.balancePence)
        assertEquals("x", e.note)
        assertNull(MoneyLedger.parseEntryResponse("""{"ok":true}"""))
    }
}
