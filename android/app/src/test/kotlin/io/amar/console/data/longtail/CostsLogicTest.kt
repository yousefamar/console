package io.amar.console.data.longtail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CostsLogicTest {

    private val full = """
        {"generatedAt": 1700000000000, "start": "2026-08-31", "end": "2026-09-07",
         "days": [
           {"date": "2026-07-28", "byOwner": {"untagged": 10}, "byModel": {"Claude Opus 5": 10}, "usd": 10},
           {"date": "2026-08-31", "byOwner": {"untagged": 40.1, "amar": 1118.1, "deenai": 3.2}, "byModel": {"Claude Fable 5": 1045.8, "Claude Opus 5": 71.2}, "usd": 1161.4},
           {"date": "2026-09-01", "byOwner": {"amar": 500}, "byModel": {"Claude Fable 5": 500}, "usd": 500}
         ],
         "owners": ["amar", "deenai", "untagged"], "models": ["Claude Fable 5", "Claude Opus 5"],
         "totalUsd": 1671.4, "avgPerDayUsd": 835.7, "avgDayCount": 2, "todayUsd": 0,
         "totalByOwner": {"untagged": 50.1, "amar": 1618.1, "deenai": 3.2},
         "totalByModel": {"Claude Fable 5": 1545.8, "Claude Opus 5": 81.2},
         "empty": false, "ownerTagEpoch": "2026-07-29",
         "ownerNames": {"amar": "Yousef", "deenai": "deen.ai"},
         "regionAttributedUsd": {"deenai": 5.28}}
    """.trimIndent()

    @Test
    fun `parses a full report`() {
        val r = parseCostReport(full)!!
        assertEquals(3, r.days.size)
        assertEquals(listOf("amar", "deenai", "untagged"), r.owners)
        assertEquals(1118.1, r.days[1].byOwner["amar"]!!, 1e-9)
        assertEquals(835.7, r.avgPerDayUsd, 1e-9)
        assertTrue(r.hasAverage)
        assertEquals(2, r.avgDayCount)
        assertEquals("Yousef", r.personName("amar"))
        assertEquals("untagged", r.personName("untagged"))
        assertEquals("sam", r.personName("sam")) // unknown tag renders as itself
        assertEquals("deen.ai ~", r.ownerLabel("deenai")) // region-attributed marker
        assertEquals("Yousef", r.ownerLabel("amar"))
        assertFalse(r.empty)
    }

    @Test
    fun `older cached report without average fields is not NaN`() {
        val r = parseCostReport(
            """{"days": [{"date": "2026-09-01", "byOwner": {"amar": 5}, "byModel": {}, "usd": 5}],
                "owners": ["amar"], "models": [], "totalUsd": 5, "totalByOwner": {"amar": 5}, "totalByModel": {}, "empty": false}""",
        )!!
        assertFalse(r.hasAverage)
        assertEquals(0.0, r.avgPerDayUsd, 0.0)
        assertTrue(r.avgPerDayUsd.isFinite())
        assertEquals("", r.ownerTagEpoch)
        assertTrue(r.ownerNames.isEmpty())
        assertNull(unattributableRange(r, CostStackBy.OWNER))
    }

    @Test
    fun `non-finite numbers are dropped, not propagated`() {
        // kotlinx-serialization is lenient=false by default; NaN reaches us as a
        // non-numeric primitive → doubleOrNull is null → treated as absent.
        val r = parseCostReport(
            """{"days": [{"date": "2026-09-01", "byOwner": {"amar": "NaN"}, "byModel": {}, "usd": "Infinity"}],
                "owners": ["amar"], "models": [], "totalUsd": "NaN", "avgPerDayUsd": "NaN", "empty": false}""",
        )!!
        assertEquals(0.0, r.totalUsd, 0.0)
        assertEquals(0.0, r.days[0].usd, 0.0)
        assertTrue(r.days[0].byOwner.isEmpty())
        assertFalse(r.hasAverage)
    }

    @Test
    fun `error body and garbage yield null`() {
        assertNull(parseCostReport("""{"error": "aws cli missing"}"""))
        assertNull(parseCostReport("not json"))
        assertNull(parseCostReport(""))
        assertNull(parseCostReport(null))
    }

    @Test
    fun `stack is cumulative in series order with untagged last`() {
        val r = parseCostReport(full)!!
        val s = stackCosts(r, CostStackBy.OWNER)
        val d = s.segments[1]
        assertEquals(listOf("amar", "deenai", "untagged"), d.map { it.key })
        assertEquals(0.0, d[0].from, 0.0)
        assertEquals(1118.1, d[0].to, 1e-9)
        assertEquals(1118.1, d[1].from, 1e-9)
        assertEquals(1121.3, d[1].to, 1e-9)
        assertEquals(1161.4, d[2].to, 1e-9)
        assertEquals(1161.4, s.maxUsd, 1e-9)
        // A day missing a series gets a zero-height segment, never a gap.
        assertEquals(0.0, s.segments[2][2].to - s.segments[2][2].from, 0.0)
    }

    @Test
    fun `stack by model uses the model series`() {
        val r = parseCostReport(full)!!
        val s = stackCosts(r, CostStackBy.MODEL)
        assertEquals(listOf("Claude Fable 5", "Claude Opus 5"), s.segments[0].map { it.key })
        assertEquals(10.0, s.segments[0][1].to, 1e-9)
    }

    @Test
    fun `empty window still has a positive y ceiling`() {
        val r = parseCostReport("""{"days": [], "owners": [], "models": [], "empty": true}""")!!
        assertTrue(r.empty)
        assertEquals(1.0, stackCosts(r, CostStackBy.OWNER).maxUsd, 0.0)
    }

    @Test
    fun `pre-epoch days are shaded only when stacking by owner`() {
        val r = parseCostReport(full)!!
        assertEquals(0..0, unattributableRange(r, CostStackBy.OWNER))
        assertNull(unattributableRange(r, CostStackBy.MODEL))
    }

    @Test
    fun `colours are stable by rank and untagged is grey`() {
        val ranked = listOf("amar", "deenai", "untagged")
        assertEquals(COST_UNTAGGED_ARGB, costColorArgb("untagged", ranked))
        assertEquals(costColorArgb("amar", ranked), costColorArgb("amar", listOf("amar", "untagged")))
        assertTrue(costColorArgb("amar", ranked) != costColorArgb("deenai", ranked))
        // untagged occupies no palette slot: the person after it keeps the next colour.
        assertEquals(costColorArgb("deenai", ranked), costColorArgb("deenai", listOf("amar", "untagged", "deenai")))
    }

    @Test
    fun `fmtUsd matches the SPA buckets`() {
        assertEquals("$0", fmtUsd(0.0))
        assertEquals("<$0.01", fmtUsd(0.004))
        assertEquals("$0.50", fmtUsd(0.5))
        assertEquals("$99.99", fmtUsd(99.99))
        assertEquals("$100", fmtUsd(100.0))
        assertEquals("$1,085", fmtUsd(1085.04))
    }

    @Test
    fun `fmtCostDay is date-only and tolerant`() {
        assertEquals("29 Jul", fmtCostDay("2026-07-29"))
        assertEquals("1 Sep", fmtCostDay("2026-09-01"))
        assertEquals("garbage", fmtCostDay("garbage"))
    }

    @Test
    fun `y ticks are nice and cover the max`() {
        val t = costYTicks(1161.4)
        assertEquals(0.0, t.first(), 0.0)
        assertTrue(t.last() >= 1161.4)
        assertTrue(t.size in 4..6)
        assertEquals(listOf(0.0), costYTicks(0.0))
        val small = costYTicks(0.37)
        assertTrue(small.last() >= 0.37)
        assertTrue(small.size in 4..6)
    }
}
