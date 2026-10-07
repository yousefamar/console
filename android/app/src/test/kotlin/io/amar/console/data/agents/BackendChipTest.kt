package io.amar.console.data.agents

import io.amar.console.data.agents.AgentsRepository.ModelState
import io.amar.console.data.agents.AgentsRepository.Spill
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class BackendChipTest {
    private val utc = ZoneId.of("UTC")

    @Test
    fun `no backend yet means no chip`() {
        assertNull(backendChipLabel(ModelState()))
    }

    @Test
    fun `max subscription reads plain`() {
        val chip = backendChipLabel(ModelState(backend = "first_party", preferred = "first_party"))!!
        assertEquals("Max", chip.label)
        assertFalse(chip.spilled)
        assertEquals("Claude Max subscription", chip.explanation)
    }

    @Test
    fun `chosen bedrock is plain not amber`() {
        val chip = backendChipLabel(ModelState(backend = "bedrock", preferred = "bedrock"))!!
        assertEquals("Bedrock", chip.label)
        assertFalse(chip.spilled)
        assertEquals("Amazon Bedrock — chosen, pay-per-token", chip.explanation)
    }

    @Test
    fun `older hub without preferred is not a spill`() {
        val chip = backendChipLabel(ModelState(backend = "bedrock"))!!
        assertFalse(chip.spilled)
    }

    @Test
    fun `spilled onto bedrock is amber with the full story`() {
        // 2026-10-06 18:30 UTC, a Tuesday.
        val returnAt = 1_791_311_400_000L
        val state = ModelState(
            backend = "bedrock", preferred = "first_party",
            spill = Spill(since = 1_791_250_000_000L, window = "seven_day", returnAt = returnAt, trippedBy = "Astera general"),
        )
        val chip = backendChipLabel(state, utc)!!
        assertEquals("Bedrock", chip.label)
        assertTrue(chip.spilled)
        assertEquals(
            "Spilled to pay-per-token Bedrock — seven_day exhausted (tripped by Astera general); due back on the subscription Tue 6 Oct 18:30",
            chip.explanation,
        )
    }

    @Test
    fun `spilled with no episode details still reads spilled`() {
        val chip = backendChipLabel(ModelState(backend = "bedrock", preferred = "first_party"), utc)!!
        assertTrue(chip.spilled)
        assertEquals("Spilled to pay-per-token Bedrock", chip.explanation)
    }
}
