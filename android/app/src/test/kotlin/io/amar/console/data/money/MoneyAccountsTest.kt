package io.amar.console.data.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `/finance/all` → accounts + their ledgers, and `/finance/networth` → byAccount. */
class MoneyAccountsTest {

    private val allBody = """
        {
          "categories": [],
          "accounts": [
            {"id":"acc_monzo","name":"Monzo","type":"monzo","liquidity":"liquid","currency":"GBP","monzoAccountId":"acc_x","sort":0},
            {"id":"acc_lloyds","name":"Lloyds","type":"manual","liquidity":"liquid","currency":"GBP","emoji":"🏦","sort":1,
             "ledger":[{"id":"bal_2","date":"2026-09-01","balancePence":150050,"note":"after rent"},
                       {"id":"bal_1","date":"2026-08-01","balancePence":120000}]},
            {"id":"acc_isa","name":"S&S ISA","type":"manual","liquidity":"investment","currency":"GBP","isExternal":true,"growthPctYoy":6.5,"notes":"held by mum"},
            {"id":"acc_old","name":"Closed","type":"manual","liquidity":"liquid","archived":true}
          ],
          "settings": {"emergencyFund": {"mode":"months","months":6}}
        }
    """.trimIndent()

    @Test
    fun `accounts parse with their ledgers, and unknown server fields are ignored`() {
        val accounts = MoneyJson.parseAccounts(allBody)
        assertEquals(listOf("acc_monzo", "acc_lloyds", "acc_isa", "acc_old"), accounts.map { it.id })

        val monzo = accounts[0]
        assertFalse(monzo.isManual)
        assertTrue(monzo.ledger.isEmpty())
        assertEquals("🟧", monzo.glyph) // 🟧 default for a Monzo account

        val lloyds = accounts[1]
        assertTrue(lloyds.isManual)
        assertEquals("🏦", lloyds.glyph)
        assertEquals(2, lloyds.ledger.size)
        assertEquals("after rent", lloyds.ledger.first { it.id == "bal_2" }.note)
        assertEquals(150_050L, lloyds.latestEntry!!.balancePence)

        val isa = accounts[2]
        assertTrue(isa.isExternal)
        assertEquals("investment", isa.liquidity)
        assertEquals("held by mum", isa.notes)
        assertEquals("💳", isa.glyph) // 💳 default for a manual account
        assertNull(isa.latestEntry)

        assertTrue(accounts[3].archived)
    }

    @Test
    fun `a missing or malformed accounts field yields no accounts rather than throwing`() {
        assertTrue(MoneyJson.parseAccounts("""{"categories":[]}""").isEmpty())
        assertTrue(MoneyJson.parseAccounts("not json").isEmpty())
        assertTrue(MoneyJson.parseAccounts("""{"accounts":"nope"}""").isEmpty())
        // An entry missing its id/name is dropped, the rest survive.
        val partial = MoneyJson.parseAccountArray(
            MoneyJson.json.parseToJsonElement("""[{"name":"no id"},{"id":"ok","name":"Fine","type":"manual","liquidity":"liquid"}]"""),
        )
        assertEquals(listOf("ok"), partial.map { it.id })
    }

    @Test
    fun `a ledger entry missing id or date is dropped`() {
        val l = MoneyJson.parseLedger(
            MoneyJson.json.parseToJsonElement("""[{"date":"2026-01-01","balancePence":1},{"id":"b","balancePence":2},{"id":"c","date":"2026-02-02","balancePence":3,"note":""}]"""),
        )
        assertEquals(listOf("c"), l.map { it.id })
        assertNull(l[0].note) // a blank note reads as none
    }

    @Test
    fun `accounts round-trip through the offline meta cache`() {
        val accounts = MoneyJson.parseAccounts(allBody)
        assertEquals(accounts, MoneyJson.decodeAccounts(MoneyJson.encodeAccounts(accounts)))
    }

    @Test
    fun `networth byAccount gives the per-account balance, and balances round-trip`() {
        val body = """{"date":"2026-10-06","liquidPence":270050,"investmentPence":500000,"totalPence":770050,
                       "byAccount":[{"accountId":"acc_monzo","balancePence":120000},{"accountId":"acc_lloyds","balancePence":150050}]}"""
        val bals = MoneyJson.parseNetWorthBalances(body)
        assertEquals(mapOf("acc_monzo" to 120_000L, "acc_lloyds" to 150_050L), bals)
        assertEquals(bals, MoneyJson.decodeBalances(MoneyJson.encodeBalances(bals)))
        assertTrue(MoneyJson.parseNetWorthBalances("""{"liquidPence":1}""").isEmpty())
        assertTrue(MoneyJson.parseNetWorthBalances("boom").isEmpty())
    }

    // ---- State helpers the Net worth section renders from ----

    private val state = MoneyRepository.State(
        accounts = MoneyJson.parseAccounts(allBody),
        balances = mapOf("acc_monzo" to 120_000L),
    )

    @Test
    fun `accountsByLiquidity drops archived rows and orders by sort then name`() {
        assertEquals(listOf("acc_monzo", "acc_lloyds"), state.accountsByLiquidity("liquid").map { it.id })
        assertEquals(listOf("acc_isa"), state.accountsByLiquidity("investment").map { it.id })
        assertTrue(state.accountsByLiquidity("illiquid").isEmpty())

        val unsorted = MoneyRepository.State(
            accounts = listOf(
                Account("b", "beta", "manual", "liquid"),
                Account("a", "Alpha", "manual", "liquid"),
            ),
        )
        assertEquals(listOf("a", "b"), unsorted.accountsByLiquidity("liquid").map { it.id })
    }

    @Test
    fun `balanceOf prefers the hub's figure and falls back to the newest reading offline`() {
        val monzo = state.accounts.first { it.id == "acc_monzo" }
        val lloyds = state.accounts.first { it.id == "acc_lloyds" }
        val isa = state.accounts.first { it.id == "acc_isa" }
        assertEquals(120_000L, state.balanceOf(monzo))
        // /finance/networth didn't list it (or never answered) → its own ledger.
        assertEquals(150_050L, state.balanceOf(lloyds))
        // No reading at all → nothing to show, not a bogus zero.
        assertNull(state.balanceOf(isa))
    }
}
