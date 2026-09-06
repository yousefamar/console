package io.amar.console.data.money

import io.amar.console.data.db.MoneyTxRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** Ports of `src/store/finance.ts` fmtPence + `src/store/money.ts` helpers, plus the hub JSON shapes. */
class MoneyModelsTest {

    // ---- fmtPence (SPA parity) --------------------------------------------

    @Test
    fun `fmtPence renders pennies below a thousand and thousands separators above`() {
        assertEquals("£12.34", MoneyFormat.fmtPence(1234))
        assertEquals("£0.07", MoneyFormat.fmtPence(7))
        assertEquals("£1,729", MoneyFormat.fmtPence(172939))
        assertEquals("£152,724", MoneyFormat.fmtPence(15272362))
    }

    @Test
    fun `fmtPence sign handling matches the SPA`() {
        assertEquals("-£829.16", MoneyFormat.fmtPence(-82916, showSign = true))
        assertEquals("+£829.16", MoneyFormat.fmtPence(82916, showSign = true))
        assertEquals("£829.16", MoneyFormat.fmtPence(82916)) // no + without showSign
        assertEquals("£829.16", MoneyFormat.fmtPence(-82916, abs = true)) // abs drops the sign
        assertEquals("£0.00", MoneyFormat.fmtPence(0, showSign = true))
    }

    @Test
    fun `row amount always shows pennies with an explicit sign`() {
        assertEquals("-£7.00", MoneyFormat.rowAmount(-700))
        assertEquals("+£385.69", MoneyFormat.rowAmount(38569))
        assertEquals("£385.69", MoneyFormat.amountAbs(-38569))
    }

    // ---- display name / reference -----------------------------------------

    private fun row(
        merchant: String? = null, counterparty: String? = null, description: String = "DESC",
        createdAt: Long = 0, amount: Long = -100,
    ) = MoneyTxRow(
        id = "tx", amount = amount, currency = "GBP", created = "", createdAt = createdAt, settled = "",
        description = description, merchantName = merchant, merchantEmoji = null, merchantLogo = null,
        counterpartyName = counterparty, monzoCategory = "general", declineReason = null, notes = null,
        categoryId = null, ignored = false, isTransfer = false,
    )

    @Test
    fun `display name prefers merchant then counterparty then description`() {
        assertEquals("Khoo Korean Fo", MoneyFormat.displayName(row(merchant = "Khoo Korean Fo", description = "CRV*SQ *KHOO")))
        assertEquals("Alice", MoneyFormat.displayName(row(counterparty = "Alice", description = "RENT")))
        assertEquals("CRV*SQ *KHOO", MoneyFormat.displayName(row(description = "CRV*SQ *KHOO")))
    }

    @Test
    fun `reference is the description only for bank transfers`() {
        assertEquals("RENT", MoneyFormat.reference(row(counterparty = "Alice", description = "RENT")))
        assertEquals("", MoneyFormat.reference(row(merchant = "Tesco", description = "TESCO STORES")))
        assertEquals("", MoneyFormat.reference(row(description = "RAW")))
    }

    // ---- runway labels ------------------------------------------------------

    private fun runway(monthsToFloor: Double?, floorDate: String?) = Runway(
        liquidPence = 172939, investmentPence = 15272362, totalPence = 15445301, emergencyFundPence = 750000,
        monthlyBurnPence = -82916, monthsToFloor = monthsToFloor, floorDate = floorDate,
        monthsToZero = null, zeroDate = null,
    )

    @Test
    fun `runway labels treat null months as infinity`() {
        val never = runway(null, null)
        assertTrue(never.neverHitsFloor)
        assertEquals("∞ mo", MoneyFormat.runwayMonthsLabel(never))
        assertEquals("never (positive cashflow)", MoneyFormat.runwayDateLabel(never))
        assertEquals(MoneyFormat.RunwayTone.GOOD, MoneyFormat.runwayTone(never))
    }

    @Test
    fun `runway labels floor fractional months and colour by threshold`() {
        val soon = runway(1.0, "2026-09")
        assertEquals("1 mo", MoneyFormat.runwayMonthsLabel(soon))
        assertEquals("Sep 2026", MoneyFormat.runwayDateLabel(soon))
        assertEquals(MoneyFormat.RunwayTone.BAD, MoneyFormat.runwayTone(soon))
        assertEquals(MoneyFormat.RunwayTone.WARN, MoneyFormat.runwayTone(runway(8.7, "2027-05")))
        assertEquals("8 mo", MoneyFormat.runwayMonthsLabel(runway(8.7, "2027-05")))
        assertEquals(MoneyFormat.RunwayTone.NEUTRAL, MoneyFormat.runwayTone(runway(24.0, "2028-09")))
    }

    @Test
    fun `emergency hint reads the months mode`() {
        assertEquals("6 mo of burn", MoneyFormat.emergencyHint(EmergencyFund("months", 6)))
        assertEquals("fixed", MoneyFormat.emergencyHint(EmergencyFund("fixed", null)))
        assertEquals("fixed", MoneyFormat.emergencyHint(null))
    }

    // ---- day grouping -----------------------------------------------------

    @Test
    fun `day labels are Today Yesterday then weekday-date`() {
        val zone = ZoneId.of("UTC")
        val now = 1_788_696_000_000L // 2026-09-06T12:00Z
        assertEquals("Today", MoneyFormat.dayLabel(now - 3_600_000, now, zone))
        assertEquals("Yesterday", MoneyFormat.dayLabel(now - 86_400_000, now, zone))
        assertEquals("Thu 3 Sep", MoneyFormat.dayLabel(now - 3 * 86_400_000, now, zone))
        assertEquals("Unknown date", MoneyFormat.dayLabel(0, now, zone))
    }

    // ---- JSON parsers -----------------------------------------------------

    @Test
    fun `parseProjection reads runway and maps JSON null to infinite months`() {
        val body = """{"trajectory":[],"runway":{"liquidPence":172939,"investmentPence":15272362,"totalPence":15445301,
            "emergencyFundPence":750000,"monthlyBurnPence":-82916,"monthsToFloor":1,"floorDate":"2026-09",
            "monthsToZero":null,"zeroDate":null},"emergencyFundPence":750000}"""
        val p = MoneyJson.parseProjection(body)!!
        assertEquals(172939L, p.runway.liquidPence)
        assertEquals(-82916L, p.runway.monthlyBurnPence)
        assertEquals(1.0, p.runway.monthsToFloor!!, 0.0)
        assertEquals("2026-09", p.runway.floorDate)
        assertNull(p.runway.monthsToZero)
        assertNull(p.runway.zeroDate)
        assertEquals(750000L, p.emergencyFundPence)
        // Round-trips through the meta cache encoding.
        assertEquals(p, MoneyJson.parseProjection(MoneyJson.encodeRunway(p)))
    }

    @Test
    fun `parseProjection returns null on a malformed body`() {
        assertNull(MoneyJson.parseProjection("{\"error\":\"nope\"}"))
        assertNull(MoneyJson.parseProjection("not json"))
    }

    @Test
    fun `parseNetWorthHistory keeps the month-end points in order and round-trips`() {
        val body = """[{"date":"2026-08-31","liquidPence":1,"investmentPence":2,"totalPence":3,"byAccount":[]},
                       {"date":"2026-09-30","liquidPence":4,"investmentPence":5,"totalPence":9,"byAccount":[]}]"""
        val pts = MoneyJson.parseNetWorthHistory(body)
        assertEquals(listOf("2026-08-31", "2026-09-30"), pts.map { it.date })
        assertEquals(9L, pts[1].totalPence)
        assertEquals(pts, MoneyJson.parseNetWorthHistory(MoneyJson.encodeNetWorthHistory(pts)))
    }

    @Test
    fun `parseCategories drops archived and reads the emergency fund setting`() {
        val body = """{"categories":[
            {"id":"cat_uncat","name":"Uncategorised","emoji":"❓","color":"#94a3b8","kind":"expense","isSystem":true},
            {"id":"cat_old","name":"Old","emoji":"x","color":"#000","kind":"expense","archived":true}],
            "settings":{"emergencyFund":{"mode":"months","months":6},"projectionHorizonMonths":60}}"""
        val cats = MoneyJson.parseCategories(body)
        assertEquals(listOf("cat_uncat"), cats.map { it.id })
        assertEquals("❓", cats[0].emoji)
        assertEquals(cats, MoneyJson.decodeCategories(MoneyJson.encodeCategories(cats)))
        val ef = MoneyJson.parseEmergencyFund(body)!!
        assertEquals(EmergencyFund("months", 6), ef)
        assertEquals(ef, MoneyJson.decodeEmergencyFund(MoneyJson.encodeEmergencyFund(ef)))
        assertEquals(EmergencyFund("fixed", null), MoneyJson.decodeEmergencyFund(MoneyJson.encodeEmergencyFund(EmergencyFund("fixed", null))))
    }

    @Test
    fun `parseTransactions handles the three merchant shapes and empty counterparty and merges classes`() {
        val body = """[
          {"id":"a","amount":-700,"currency":"GBP","created":"2026-09-05T14:11:12.725Z","settled":"",
           "description":"CRV*SQ *KHOO","merchant":{"name":"Khoo Korean Fo","emoji":"","logo":""},"counterparty":{},
           "category":"eating_out","decline_reason":null,"notes":""},
          {"id":"b","amount":120000,"currency":"GBP","created":"2026-09-04T09:00:00Z","settled":"2026-09-04T09:00:01Z",
           "description":"SALARY SEP","merchant":null,"counterparty":{"name":"ACME LTD","preferred_name":"Acme"},
           "category":"income","notes":"payday"},
          {"id":"c","amount":-500,"currency":"GBP","created":"2026-09-03T10:00:00Z","settled":"",
           "description":"pot","merchant":"merch_123","counterparty":{},"category":"transfers","decline_reason":"INSUFFICIENT_FUNDS"}
        ]"""
        val classes = mapOf(
            "a" to TxClassification("cat_eatingout", ignored = false, isTransfer = false),
            "b" to TxClassification("cat_salary", ignored = false, isTransfer = false),
        )
        val rows = MoneyJson.parseTransactions(body, classes)
        assertEquals(3, rows.size)

        val a = rows[0]
        assertEquals("Khoo Korean Fo", a.merchantName)
        assertNull(a.merchantEmoji) // "" → null
        assertNull(a.merchantLogo)
        assertNull(a.counterpartyName) // {} → null
        assertEquals("cat_eatingout", a.categoryId)
        assertEquals(1_788_617_472_725L, a.createdAt)
        assertEquals("Khoo Korean Fo", MoneyFormat.displayName(a))

        val b = rows[1]
        assertNull(b.merchantName)
        assertEquals("Acme", b.counterpartyName) // preferred_name wins
        assertEquals("payday", b.notes)
        assertEquals("SALARY SEP", MoneyFormat.reference(b))

        val c = rows[2]
        assertEquals("merch_123", c.merchantName) // string merchant id kept as the name
        assertEquals("INSUFFICIENT_FUNDS", c.declineReason)
        assertNull(c.categoryId) // unclassified
        assertFalse(c.isTransfer)
    }

    @Test
    fun `parseClassifications and parseStatus read the hub shapes`() {
        val cls = MoneyJson.parseClassifications("""{"tx_1":{"categoryId":"cat_x","ignored":true,"isTransfer":false,"sharedFraction":1}}""")
        assertEquals(TxClassification("cat_x", ignored = true, isTransfer = false), cls["tx_1"])
        val st = MoneyJson.parseStatus("""{"connected":false,"hasCredentials":true,"accountId":"acc","lastSync":"2026-04-25T21:46:10.215Z","transactionCount":4448,"fullSyncComplete":true}""")!!
        assertFalse(st.connected)
        assertTrue(st.hasCredentials)
        assertEquals(4448, st.transactionCount)
        assertEquals("2026-04-25T21:46:10.215Z", st.lastSync)
    }
}
